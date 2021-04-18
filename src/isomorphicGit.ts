import git, { ReadCommitResult } from 'isomorphic-git';
import http from "isomorphic-git/http/web";
import { Notice } from 'obsidian';
import { GitManager } from "./gitManager";
import ObsidianGit from './main';
import { BranchInfo, DiffResult, FileStatusResult, PluginState, Status } from './types';

export class IsomorphicGit extends GitManager {
    private fs: any;
    private dir: string;
    private readonly FILE = 0;
    private readonly HEAD = 1;
    private readonly WORKDIR = 2;
    private readonly STAGE = 3;
    private readonly indexes = {
        "000": "",
        "003": "AD",
        "020": "??",
        "022": "A",
        "023": "AM",
        "100": "D ",
        "101": " D",
        "103": "MD",
        "110": "D ??",
        "111": "",
        "120": "D ??",
        "121": " M",
        "122": "M ",
        "123": "MM"
    };

    constructor(plugin: ObsidianGit) {
        super(plugin);
        this.fs = (this.app.vault.adapter as any).fs;
        this.dir = decodeURIComponent(this.app.vault.adapter.getResourcePath("").replace("app://local/", ""));
        this.dir = this.dir.substring(0, this.dir.indexOf("?"));
    }

    async status(): Promise<Status> {
        this.plugin.setState(PluginState.status);
        try {
            const status = await git.statusMatrix({
                fs: this.fs,
                dir: this.dir,
            });

            const changed: FileStatusResult[] = status.filter(row => row[this.HEAD] !== row[this.WORKDIR]).map(row => this.getFileStatusResult(row));
            const staged = status.filter(row => row[this.STAGE] === 3 || row[this.STAGE] === 2).map(row => row[this.FILE]);

            return {
                changed: changed,
                staged: staged,
            };
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async commitAll(message?: string): Promise<number | undefined> {
        this.plugin.setState(PluginState.commit);
        try {
            const commitBefore = await this.getCurrentCommit();

            const repo = {
                fs: this.fs,
                dir: this.dir
            };
            const status = await git.statusMatrix(repo);
            await Promise.all(
                status.map(([filepath, , worktreeStatus]) =>
                    worktreeStatus ? git.add({ ...repo, filepath }) : git.remove({ ...repo, filepath })
                )
            );
            const formatMessage = message ?? await this.formatCommitMessage();

            await git.commit({
                ...repo,
                message: formatMessage
            });
            const commitAfter = await this.getCurrentCommit();
            this.plugin.lastUpdate = Date.now();

            //If the repo has no commits yet, `commitBefore` is undefined
            if (commitBefore) {
                return await this.getChangedFiles(commitBefore.oid, commitAfter.oid);
            } else {
                return undefined;
            }
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    async pull(): Promise<number> {
        this.plugin.setState(PluginState.pull);
        try {
            const commitBefore = await this.getCurrentCommit();

            await git.pull({
                fs: this.fs,
                dir: this.dir,
                http: http,
                corsProxy: this.plugin.settings.proxyURL,
                onAuth: () => {
                    const username = window.localStorage.getItem(this.plugin.manifest.id + ":username");
                    const password = window.localStorage.getItem(this.plugin.manifest.id + ":password");
                    return { username: username, password: password };
                }
            });
            this.plugin.lastUpdate = Date.now();

            const commitAfter = await this.getCurrentCommit();

            return await this.getChangedFiles(commitBefore.oid, commitAfter.oid);
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    async push(): Promise<number> {
        this.plugin.setState(PluginState.push);
        try {
            const branchInfo = await this.branchInfo();
            const changedFiles = await this.getChangedFiles(branchInfo.current, branchInfo.tracking);

            await git.push({
                fs: this.fs,
                dir: this.dir,
                http: http,
                corsProxy: this.plugin.settings.proxyURL,
                onAuth: () => {
                    const username = window.localStorage.getItem(this.plugin.manifest.id + ":username");
                    const password = window.localStorage.getItem(this.plugin.manifest.id + ":password");
                    return { username: username, password: password };
                }
            });
            this.plugin.lastUpdate = Date.now();
            return changedFiles;
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    async canPush(): Promise<boolean> {
        const branchInfo = await this.branchInfo();
        return await this.getChangedFiles(branchInfo.current, branchInfo.tracking) !== 0;
    };

    async checkRequirements(): Promise<"valid" | "missing-repo" | "wrong-settings"> {
        try {
            await git.log({
                fs: this.fs,
                dir: this.dir,
                depth: 1
            });
        } catch (error) {
            if (error.code === "NotFoundError" && error.data.what === "HEAD") {
                return "missing-repo";
            }
        }
        const user = await git.getConfig({ fs: this.fs, dir: this.dir, path: "user.name" });
        const email = await git.getConfig({ fs: this.fs, dir: this.dir, path: "user.email" });
        const remoteURL = await git.getConfig({ fs: this.fs, dir: this.dir, path: "remote.origin.url" });

        if (!user || !email || !remoteURL) {
            return "wrong-settings";
        }

        return "valid";
    };

    async branchInfo(listRemoteBranches: boolean = false): Promise<BranchInfo> {

        try {
            const current = await git.currentBranch({
                fs: this.fs,
                dir: this.dir
            }) || "";

            const branches = await git.listBranches({
                fs: this.fs,
                dir: this.dir,
            });

            const remote = await git.getConfig({
                fs: this.fs,
                dir: this.dir,
                path: `branch.${current}.remote`
            }) ?? "origin";

            const branch = (await git.getConfig({
                fs: this.fs,
                dir: this.dir,
                path: `branch.${current}.merge`
            }))?.split("refs/heads")[1] ?? "";

            let remoteBranches: string[];
            if (listRemoteBranches) {
                remoteBranches = await git.listBranches({
                    fs: this.fs,
                    dir: this.dir,
                    remote: remote
                });
                remoteBranches.remove("HEAD");
                remoteBranches = remoteBranches.map(e => `${remote}/${e}`);
            }

            return {
                current: current,
                tracking: remote + branch,
                branches: branches,
                remoteBranches: remoteBranches
            };
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    async checkout(branch: string): Promise<void> {
        try {
            return git.checkout({
                fs: this.fs,
                dir: this.dir,
                ref: branch,
            });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    async init(): Promise<void> {
        try {
            return git.init({
                fs: this.fs,
                dir: this.dir
            });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    setConfig(path: string, value: any): Promise<void> {
        try {
            return git.setConfig({
                fs: this.fs,
                dir: this.dir,
                path: path,
                value: value
            });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    getConfig(path: string): Promise<any> {
        try {
            return git.getConfig({
                fs: this.fs,
                dir: this.dir,
                path: path
            });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    };

    async fetch(): Promise<void> {
        if (!this.plugin.settings.proxyURL) {
            new Notice("Please specify a proxy URL");
            return;
        };
        try {
            await git.fetch({
                fs: this.fs,
                dir: this.dir,
                http: http,
                corsProxy: this.plugin.settings.proxyURL,
                onAuth: () => {
                    const username = window.localStorage.getItem(this.plugin.manifest.id + ":username");
                    const password = window.localStorage.getItem(this.plugin.manifest.id + ":password");
                    return { username: username, password: password };
                }
            });
        } catch (error) {
            this.plugin.displayError(error);
            throw error;
        }
    }

    private getFileStatusResult(row: [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3]): FileStatusResult {
        const index = (this.indexes as any)[`${row[this.HEAD]}${row[this.WORKDIR]}${row[this.STAGE]}`];

        return { index: index, path: row[this.FILE] };
    }

    private async getCurrentCommit(): Promise<ReadCommitResult | undefined> {
        try {
            return (await git.log({
                fs: this.fs,
                dir: this.dir,
                depth: 1
            }))[0];
        } catch (error) {
            const branch = await this.branchInfo();
            if (error.code === "NotFoundError" && error.data.what === `refs/heads/${branch.current}`) {
                return undefined;
            } else {
                throw error;
            }
        }
    };

    private async getChangedFiles(commitHash1: string, commitHash2: string): Promise<number> {
        return (await this.diff(commitHash1, commitHash2)).filter(file => file.type !== "equal").length;
    };

    // fixed from https://isomorphic-git.org/docs/en/snippets#git-diff-name-status-commithash1-commithash2
    private async diff(commitHash1: string, commitHash2: string): Promise<DiffResult[]> {
        return git.walk({
            fs: this.fs,
            dir: this.dir,
            trees: [git.TREE({ ref: commitHash1 }), git.TREE({ ref: commitHash2 })],
            map: async (filepath, [A, B]) => {

                // ignore directories
                if (filepath === '.') {
                    return;
                }
                if ((await A?.type()) === 'tree' || (await B?.type()) === 'tree') {
                    return;
                }

                // generate ids
                const Aoid = await A?.oid();
                const Boid = await B?.oid();

                // determine modification type
                let type = 'equal';
                if (Aoid !== Boid) {
                    type = 'modify';
                }
                if (Aoid === undefined) {
                    type = 'remove';
                }
                if (Boid === undefined) {
                    type = 'add';
                }
                if (Aoid === undefined && Boid === undefined) {
                    console.log('Something weird happened:');
                    console.log(A);
                    console.log(B);
                }

                return {
                    path: `/${filepath}`,
                    type: type,
                };
            },
        });
    }
}