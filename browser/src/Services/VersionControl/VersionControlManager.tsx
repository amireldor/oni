import { capitalize } from "lodash"
import * as Oni from "oni-api"
import * as Log from "oni-core-logging"
import { IDisposable } from "oni-types"
import * as React from "react"

import { store, SupportedProviders, VersionControlPane, VersionControlProvider } from "./"
import { Notifications } from "./../../Services/Notifications"
import { Branch } from "./../../UI/components/VersionControl/Branch"
import { MenuManager } from "./../Menu"
import { SidebarManager } from "./../Sidebar"
import { IWorkspace } from "./../Workspace"

interface ISendNotificationsArgs {
    detail: string
    level: "info" | "warn"
    title: string
    expiration?: number
}

export type ISendVCSNotification = (args: ISendNotificationsArgs) => void

export class VersionControlManager {
    private _vcs: SupportedProviders
    private _vcsProvider: VersionControlProvider
    private _menuInstance: Oni.Menu.MenuInstance
    private _vcsStatusItem: Oni.StatusBarItem
    private _subscriptions: IDisposable[] = []
    private _providers = new Map<string, VersionControlProvider>()

    constructor(
        private _workspace: IWorkspace,
        private _editorManager: Oni.EditorManager,
        private _statusBar: Oni.StatusBar,
        private _menu: MenuManager,
        private _commands: Oni.Commands.Api,
        private _sidebar: SidebarManager,
        private _notifications: Notifications,
        private _configuration: Oni.Configuration,
    ) {}

    public get providers() {
        return this._providers
    }

    public get activeProvider(): VersionControlProvider {
        return this._vcsProvider
    }

    public async registerProvider(provider: VersionControlProvider): Promise<void> {
        if (provider) {
            this._providers.set(provider.name, provider)
            const canHandleWorkspace = await provider.canHandleWorkspace()
            if (canHandleWorkspace) {
                await this._activateVCSProvider(provider)
            }

            this._workspace.onDirectoryChanged.subscribe(async dir => {
                const providerToUse = await this.getCompatibleProvider(dir)
                await this.handleProviderStatus(providerToUse)
            })
        }
    }

    // Use arrow function to maintain this binding of sendNotification
    public sendNotification: ISendVCSNotification = ({ expiration = 3_000, ...args }) => {
        const notification = this._notifications.createItem()
        notification.setContents(args.title, args.detail)
        notification.setExpiration(expiration)
        notification.setLevel(args.level)
        notification.show()
    }

    public deactivateProvider(): void {
        this._vcsProvider.deactivate()
        this._subscriptions.map(s => s.dispose())
        if (this._vcsStatusItem) {
            this._vcsStatusItem.hide()
        }
        this._vcsProvider = null
        this._vcs = null
    }

    public async handleProviderStatus(newProvider: VersionControlProvider): Promise<void> {
        const isSameProvider = this._vcsProvider && newProvider && this._vcs === newProvider.name
        const noCompatibleProvider = this._vcsProvider && !newProvider
        const newReplacementProvider = Boolean(this._vcsProvider && newProvider)
        const compatibleProvider = Boolean(!this._vcsProvider && newProvider)

        switch (true) {
            case isSameProvider:
                break
            case noCompatibleProvider:
                this.deactivateProvider()
                break
            case newReplacementProvider:
                this.deactivateProvider()
                await this._activateVCSProvider(newProvider)
                break
            case compatibleProvider:
                await this._activateVCSProvider(newProvider)
                break
            default:
                break
        }
    }

    private async getCompatibleProvider(dir: string): Promise<VersionControlProvider | null> {
        const allCompatibleProviders: VersionControlProvider[] = []
        for (const vcs of this._providers.values()) {
            const isCompatible = await vcs.canHandleWorkspace(dir)
            if (isCompatible) {
                allCompatibleProviders.push(vcs)
            }
        }
        // TODO: when we have multiple providers we will need logic to determine which to
        // use if more than one is compatible
        const [providerToUse] = allCompatibleProviders

        return providerToUse
    }

    private _activateVCSProvider = async (provider: VersionControlProvider) => {
        this._vcs = provider.name
        this._vcsProvider = provider
        await this._initialize()
        provider.activate()
    }

    private async _initialize() {
        try {
            await this._updateBranchIndicator()
            this._setupSubscriptions()

            const hasVcsSidebar = this._sidebar.entries.some(({ id }) => id.includes("vcs"))
            const enabled = this._configuration.getValue("experimental.vcs.sidebar")

            if (!hasVcsSidebar && enabled) {
                const vcsPane = new VersionControlPane(
                    this._editorManager,
                    this._workspace,
                    this._vcsProvider,
                    this.sendNotification,
                    this._commands,
                    this._sidebar,
                    store,
                )
                this._sidebar.add("code-fork", vcsPane)
            }

            this._registerCommands()
        } catch (e) {
            Log.warn(`Failed to initialise provider, because, ${e.message}`)
        }
    }

    private _setupSubscriptions() {
        this._subscriptions = [
            this._editorManager.activeEditor.onBufferEnter.subscribe(async () => {
                await this._updateBranchIndicator()
            }),
            this._vcsProvider.onBranchChanged.subscribe(async newBranch => {
                await this._updateBranchIndicator(newBranch)
                await this._editorManager.activeEditor.neovim.command("e!")
            }),
            this._editorManager.activeEditor.onBufferSaved.subscribe(async () => {
                await this._updateBranchIndicator()
            }),
            (this._workspace as any).onFocusGained.subscribe(async () => {
                await this._updateBranchIndicator()
            }),
        ]
    }

    private _registerCommands = () => {
        const toggleVCS = () => {
            this._sidebar.toggleVisibilityById("oni.sidebar.vcs")
        }

        this._commands.registerCommand({
            command: "vcs.sidebar.toggle",
            name: "Version Control: Toggle Visibility",
            detail: "Toggles the vcs pane in the sidebar",
            execute: toggleVCS,
            enabled: () => this._configuration.getValue("experimental.vcs.sidebar"),
        })

        this._commands.registerCommand({
            command: `vcs.fetch`,
            name: "Fetch the selected branch",
            detail: "",
            execute: this._fetchBranch,
        })

        this._commands.registerCommand({
            command: `vcs.branches`,
            name: `Local ${capitalize(this._vcs)} Branches`,
            detail: "Open a menu with a list of all local branches",
            execute: this._createBranchList,
        })
    }

    private _updateBranchIndicator = async (branchName?: string) => {
        if (!this._vcsProvider) {
            return
        } else if (!this._vcsStatusItem) {
            const vcsId = `oni.status.${this._vcs}`
            this._vcsStatusItem = this._statusBar.createItem(1, vcsId)
        }

        try {
            // FIXME: there is race condition on deactivation of the provider
            const branch = await this._vcsProvider.getBranch()
            const diff = await this._vcsProvider.getDiff()

            if (!branch || !diff) {
                return Log.warn(`The ${!branch ? "branch name" : "diff"} could not be found`)
            } else if (!branch && !diff) {
                return this._vcsStatusItem.hide()
            }

            this._vcsStatusItem.setContents(<Branch branch={branch} diff={diff} />)
            this._vcsStatusItem.show()
        } catch (e) {
            this._notifyOfError(e)
            return this._vcsStatusItem.hide()
        }
    }

    private _createBranchList = async () => {
        if (!this._vcsProvider) {
            return
        }

        const [currentBranch, branches] = await Promise.all([
            this._vcsProvider.getBranch(),
            this._vcsProvider.getLocalBranches(),
        ])

        this._menuInstance = this._menu.create()

        if (!branches) {
            return
        }

        const branchItems = branches.all.map(branch => ({
            label: branch,
            icon: "code-fork",
            pinned: currentBranch === branch,
        }))

        this._menuInstance.show()
        this._menuInstance.setItems(branchItems)

        this._menuInstance.onItemSelected.subscribe(async menuItem => {
            if (menuItem && menuItem.label) {
                try {
                    await this._vcsProvider.changeBranch(menuItem.label)
                } catch (e) {
                    this._notifyOfError(e)
                }
            }
        })
    }

    private _notifyOfError(error: Error) {
        const name = this._vcsProvider ? capitalize(this._vcs) : "VCS"
        const errorMessage = error && error.message ? error.message : null
        this.sendNotification({
            title: `${capitalize(name)} Plugin Error:`,
            detail: `${name} plugin encountered an error ${errorMessage}`,
            level: "warn",
        })
    }

    private _fetchBranch = async () => {
        if (this._menuInstance.isOpen() && this._menuInstance.selectedItem) {
            try {
                await this._vcsProvider.fetchBranchFromRemote({
                    currentDir: this._workspace.activeWorkspace,
                    branch: this._menuInstance.selectedItem.label,
                })
            } catch (e) {
                this._notifyOfError(e)
            }
        }
    }
}

// Shelter the instance from the global scope -> globals are evil.
function init() {
    let Provider: VersionControlManager

    const Activate = (
        workspace: IWorkspace,
        editorManager: Oni.EditorManager,
        statusBar: Oni.StatusBar,
        commands: Oni.Commands.Api,
        menu: MenuManager,
        sidebar: SidebarManager,
        notifications: Notifications,
        configuration: Oni.Configuration,
    ): void => {
        Provider = new VersionControlManager(
            workspace,
            editorManager,
            statusBar,
            menu,
            commands,
            sidebar,
            notifications,
            configuration,
        )
    }

    const GetInstance = () => {
        return Provider
    }

    return {
        activate: Activate,
        getInstance: GetInstance,
    }
}
export const { activate, getInstance } = init()
