import { CancellationToken, Disposable, ExtensionContext, Progress, ProgressLocation, commands, window, workspace } from 'vscode';
import {
    createCondaEnvironment,
    exportPackages,
    installPackage,
    searchPackage,
    uninstallPackage,
    updatePackage,
    updatePackages,
} from '../packages';
import { traceError } from '../../client/logging';
import { EnvironmentWrapper, Package, PackageWrapper } from './types';
import { ActiveWorkspaceEnvironment, WorkspaceFoldersTreeDataProvider } from './foldersTreeDataProvider';
import { PythonEnvironmentsTreeDataProvider } from './environmentsTreeDataProvider';
import { IDisposable } from '../../client/common/types';
import { sleep } from '../../client/common/utils/async';
import { withProgress } from '../../client/common/vscodeApis/windowApis';
import { disposeAll } from '../../client/common/utils/resourceLifecycle';
import { Common, CreateEnv } from '../../client/common/utils/localize';
import { Commands } from '../../client/common/constants';

function triggerChanges(item: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WorkspaceFoldersTreeDataProvider.instance.triggerChanges(item as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PythonEnvironmentsTreeDataProvider.instance.triggerChanges(item as any);
}

export function registerCommands(context: ExtensionContext) {
    const disposables: IDisposable[] = [];
    disposables.push(
        commands.registerCommand('python.envManager.updatePackage', async (pkg: Package) => {
            const yes = await window.showWarningMessage(
                `Are you sure you want to update the package '${pkg.pkg.name} to the latest version ${pkg.latestVersion}?`,
                { modal: true },
                'Yes',
                'No',
            );
            if (!yes || yes === 'No') {
                return;
            }

            pkg.status = 'DetectingLatestVersion';
            triggerChanges(pkg);
            await updatePackage(pkg.env, pkg.pkg).catch((ex) =>
                traceError(`Failed to update package ${pkg.pkg.name} in ${pkg.env.id}`, ex),
            );
            pkg.status = undefined;

            // Other packages may have been updated, so refresh all packages.
            triggerChanges(pkg.parent);
        }),
    );
    disposables.push(
        commands.registerCommand('python.envManager.uninstallPackage', async (pkg: Package) => {
            const yes = await window.showWarningMessage(
                `Are you sure you want to uninstall the package '${pkg.pkg.name}'?`,
                { modal: true },
                'Yes',
                'No',
            );
            if (yes === 'No') {
                return;
            }

            pkg.status = 'UnInstalling';
            triggerChanges(pkg);
            uninstallPackage(pkg.env, pkg.pkg);

            pkg.status = undefined;

            // Other packages may have been uninstalled, so refresh all packages.
            triggerChanges(pkg.parent);
            // Found that we might need to wait for a bit before refreshing the tree.
            await sleep(1000);
            triggerChanges(pkg.parent);
        }),
    );
    disposables.push(
        commands.registerCommand('python.envManager.searchAndInstallPackage', async (pkg: PackageWrapper) => {
            const result = await searchPackage(pkg.env).catch((ex) =>
                traceError(`Failed to install a package in ${pkg.env.id}`, ex),
            );
            if (!result) {
                return;
            }
            await installPackage(pkg.env, result);

            // Other packages may have been updated, so refresh all packages.
            triggerChanges(pkg);
        }),
    );
    disposables.push(
        commands.registerCommand(
            'python.envManager.exportEnvironment',
            async (options: ActiveWorkspaceEnvironment | EnvironmentWrapper) => {
                const env = options instanceof EnvironmentWrapper ? options.env : options.asNode()?.env;
                if (!env) {
                    return;
                }
                const exportedData = await exportPackages(env).catch((ex) =>
                    traceError(`Failed to export env ${env.id}`, ex),
                );
                if (!exportedData) {
                    return;
                }
                const doc = await workspace.openTextDocument({
                    content: `# ${exportedData.file}\n\n${exportedData.contents}`,
                    language: exportedData.language,
                });
                window.showTextDocument(doc);
            },
        ),
    );
    disposables.push(
        commands.registerCommand('python.envManager.updateAllPackages', async (pkg: PackageWrapper) => {
            const yes = await window.showWarningMessage(
                `Are you sure you want to update all the packages?`,
                { modal: true },
                'Yes',
                'No',
            );
            if (yes === 'No') {
                return;
            }

            pkg.packages.forEach((e) => {
                e.status = 'UpdatingToLatest';
                triggerChanges(e);
            });

            await updatePackages(pkg.env);

            // Other packages may have been uninstalled, so refresh all packages.
            triggerChanges(pkg);
        }),
    );
    disposables.push(
        commands.registerCommand('python.envManager.refreshPackages', async (pkg: PackageWrapper) =>
            triggerChanges(pkg),
        ),
    );
    disposables.push(
        commands.registerCommand(
            'python.envManager.downloadPython',
            async (options: EnvironmentWrapper) => {
                const { env } = options;
                if (!env) {
                    console.error("Can't download Python for environment.")
                    return;
                }

                const name = options.env.environment?.name

                const message = `确定要下载 python 环境 ${name} 至 IDE 吗？`;
                const detail = `即将下载环境 ${name} 到本地`;
                if ((await window.showInformationMessage(message, { modal: true, detail }, 'Yes')) !== 'Yes') {
                    return;
                }
                try {
                    await withProgress(
                        {
                            location: ProgressLocation.Notification,
                            title: `${CreateEnv.statusTitle} ([${Common.showLogs}](command:${Commands.ViewOutput}))`,
                            cancellable: true,
                        },
                        async (
                            progress: Progress<{ message?: string | undefined; increment?: number | undefined }>,
                            _token: CancellationToken,
                        ) => {
                            console.log("download env.....");
                            console.log(`createCondaEnvironment, print level: ${JSON.stringify(options.env)}`)
                            const result = await createCondaEnvironment(options.env, progress);
                            if (result) {
                                const { envName } = result;
                                // await commands.executeCommand('python.envManager.refresh', true);
                                console.log(`提交至项目空间：${envName}}...`);
                                progress.report({ message: `提交至项目空间：${envName}}...` });
                            } else {
                                // 处理结果为undefined的情况
                            }
                        },
                    );
                    return commands.executeCommand('python.envManager.refresh');
                } catch (ex) {
                    traceError(`环境 ${name} 下载失败`, ex);
                    return window.showErrorMessage(`环境 ${name} 提交失败, ${ex}`);
                }
            },
        ),
    );

    context.subscriptions.push(new Disposable(() => disposeAll(disposables)));
}
