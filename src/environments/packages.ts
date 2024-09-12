import { Environment, ResolvedEnvironment } from '@vscode/python-extension';
import { CancellationError, Progress, ProgressLocation, QuickPickItem, window } from 'vscode';
// import { exec } from 'child_process';
// import { promisify } from 'util';
import axios from 'axios';
import { exec } from 'child_process';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { traceError, traceVerbose } from '../client/logging';
import {
    OutdatedPipPackageInfo,
    PipPackageInfo,
    exportPipPackages,
    getInstallPipPackageSpawnOptions,
    getOutdatedPipPackages,
    getPipPackages,
    getUninstallPipPackageSpawnOptions,
    searchPipPackage,
    updatePipPackage,
    updatePipPackages,
} from './tools/pip';
import {
    CondaPackageInfo,
    exportCondaPackages,
    getCondaPackageInstallSpawnOptions,
    getCondaPackages,
    getOutdatedCondaPackages,
    getUninstallCondaPackageSpawnOptions,
    searchCondaPackage,
    updateCondaPackage,
    updateCondaPackages,
} from './tools/conda';
import { getEnvironmentType, isCondaEnvironment } from './utils';
import ContextManager, { EnvironmentType, PySparkParam } from '../client/pythonEnvironments/info';
import {
    exportPoetryPackages,
    getPoetryPackageInstallSpawnOptions,
    getUninstallPoetryPackageSpawnOptions,
    searchPoetryPackage,
    updatePoetryPackages,
} from './tools/poetry';
import { SpawnOptions } from '../client/common/process/types';
import { getEnvLoggingInfo, reportStdOutProgress } from './helpers';
import { searchPackageWithProvider } from './packageSearch';
import { Conda } from '../client/pythonEnvironments/common/environmentManagers/conda';
import { execObservable } from '../client/common/process/rawProcessApis';


export type PackageInfo = PipPackageInfo | CondaPackageInfo;
export type OutdatedPackageInfo = OutdatedPipPackageInfo;

export async function getPackages(env: Environment) {
    try {
        const [pipPackages, condaPackages] = await Promise.all([getPipPackages(env), getCondaPackages(env)]);
        const packages = new Map<string, PackageInfo>();
        (pipPackages || []).forEach((pkg) => packages.set(pkg.name, pkg));
        // Use conda packages as source of truth, as we might have more information
        // when getting conda packages.
        (condaPackages || []).forEach((pkg) => packages.set(pkg.name, pkg));
        return Array.from(packages.values()).sort((a, b) =>
            a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
        );
    } catch (ex) {
        traceError(`Failed to get package information for ${env.id})`, ex);
        return [];
    }
}
export async function getOutdatedPackages(env: Environment) {
    try {
        const [pipPackages, condaPackages] = await Promise.all([
            getOutdatedPipPackages(env),
            getOutdatedCondaPackages(env),
        ]);
        return condaPackages || pipPackages || new Map<string, string>();
    } catch (ex) {
        traceError(`Failed to get latest package information for ${env.id})`, ex);
        return new Map<string, string>();
    }
}

export async function updatePackage(env: Environment, pkg: PackageInfo) {
    try {
        if (isCondaEnvironment(env)) {
            await updateCondaPackage(env, pkg);
        } else {
            await updatePipPackage(env, pkg);
        }
    } catch (ex) {
        traceError(`Failed to update package ${pkg.name} in ${env.id})`, ex);
        return [];
    }
}
export async function updatePackages(env: Environment) {
    try {
        if (isCondaEnvironment(env)) {
            await updateCondaPackages(env);
        } else if (getEnvironmentType(env) === EnvironmentType.Poetry) {
            await updatePoetryPackages(env);
        } else {
            await updatePipPackages(env);
        }
    } catch (ex) {
        traceError(`Failed to update packages in ${env.id})`, ex);
        return [];
    }
}
export async function uninstallPackage(env: Environment, pkg: PackageInfo) {
    await window.withProgress(
        { location: ProgressLocation.Notification, cancellable: true, title: `Uninstalling ${pkg.name}` },
        async (progress, token) => {
            let result: {
                command: string;
                args: string[];
                options?: SpawnOptions | undefined;
            };
            try {
                if (isCondaEnvironment(env)) {
                    result = await getUninstallCondaPackageSpawnOptions(env, pkg, token);
                } else if (getEnvironmentType(env) === EnvironmentType.Poetry) {
                    result = await getUninstallPoetryPackageSpawnOptions(env, pkg.name, token);
                } else {
                    result = await getUninstallPipPackageSpawnOptions(env, pkg, token);
                }
                const message = `Uninstalling package ${pkg.name} from ${getEnvLoggingInfo(env)} with command ${[
                    result.command,
                    ...result.args,
                ]}]}`;
                await reportStdOutProgress(
                    message,
                    [result.command, result.args, { timeout: 60_000, ...(result.options || {}) }],
                    progress,
                    token,
                );
            } catch (ex) {
                traceError(`Failed to uninstall package ${pkg.name} in ${env.id})`, ex);
                return [];
            }
        },
    );
}
export async function exportPackages(env: Environment) {
    try {
        if (isCondaEnvironment(env)) {
            return exportCondaPackages(env);
        }
        if (getEnvironmentType(env) === EnvironmentType.Poetry) {
            return exportPoetryPackages(env);
        }
        return exportPipPackages(env);
    } catch (ex) {
        traceError(`Failed to export environment ${env.id}`, ex);
    }
}

interface PySparkEnvironmentMeta {
    id: number;
    proId: number;
    name: string;
    hdfsPath: string;
    detail: string;
    description: string | null;
    createBy: string;
    createTime: string;
    level: number;
}

async function fetchPySparkEnvironmentMeta(proId: string, name: string, level: number): Promise<PySparkEnvironmentMeta> {
    try {
        if (level === undefined || level === null) {
            level = 1;
        }
        const response = await axios.get<PySparkEnvironmentMeta>(`${ContextManager.getInstance().getContext().globalState.get<string>('gateway.addr')}/api/v1/env/pyspark/meta`, {
            params: { proId, name, level },
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw',
                'Content-Type': 'application/json',
                'operator': 'hu.tan@msxf.com'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error fetching PySpark environment meta:', error);
        throw error;
    }
}

/**
 * 解压 tar.gz 文件到指定目录
 * @param tarGzFilePath 要解压的 tar.gz 文件路径
 * @param targetDirectory 目标目录
 */
async function unpackCondaEnvironment(tarGzFilePath: string, targetDirectory: string): Promise<void> {
    try {
        // 检查 targetDirectory 是否存在，不存在则创建
        await fs.mkdir(targetDirectory, { recursive: true });

        // 构造解压命令
        const command = `tar -xzf ${tarGzFilePath} -C ${targetDirectory}`;

        // 执行解压命令
        await new Promise<void>((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error occurred while unpacking: ${stderr}`);
                    reject(error);
                    return;
                }
                console.log(`stdout: ${stdout}`);
                console.log(`Successfully unpacked to ${targetDirectory}`);
                resolve();
            });
        });
    } catch (error) {
        // 使用 instanceof 检查 error 是否是 Error 对象
        if (error instanceof Error) {
            console.error(`Failed to unpack environment: ${error.message}`);
        } else {
            console.error('Failed to unpack environment: An unknown error occurred.');
        }
        throw error;
    }
}

export async function createCondaEnvironment(
    env: Environment | ResolvedEnvironment,
    progress: Progress<{ message?: string | undefined; increment?: number | undefined }>,
) {
    if (!env.environment?.name) {
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }
    const message = `Download conda environment ${getEnvLoggingInfo(env)}`;
    traceVerbose(message);
    progress.report({ message });
    // const hdfs = `hdfs://ms-dwh/tmp/${env.environment?.name}.tar.gz`
    // 调用示例
    // const proId = 1;
    // 获取存储的 PySparkParam 对象
    const pySparkParam = ContextManager.getInstance().getContext().globalState.get<PySparkParam>('pyspark.paramRegister');

    let proId = "0";
    // 检查是否成功获取到数据
    if (pySparkParam) {
        // 通过属性名获取 projectId 和 projectCode
        const { projectId } = pySparkParam;
        const { projectCode } = pySparkParam;

        console.log(`createCondaEnvironment Project ID: ${projectId}`);
        console.log(`createCondaEnvironment Project Code: ${projectCode}`);

        if (projectId) {
            proId = projectId;
        }
    } else {
        console.log('No PySparkParam found in global state.');
    }
    await fetchPySparkEnvironmentMeta(proId, env.environment.name, env.environment.level)
        .then(async (data) => {
            console.log('Environment Meta:', data);
            const hdfs = data.hdfsPath;
            traceError(`env hdfs dir: ${hdfs}`)
            // /tmp/env1.tar.gz
            // 生成一个 UUID
            const uniqueId = uuidv4();
            const localTmpTar = `/tmp/${uniqueId}.tar.gz`;
            const result1 = execObservable("hdfs", ["dfs", "-get", hdfs, localTmpTar], { timeout: 600_000 });
            await new Promise<void>((resolve) => {
                result1.out.subscribe({
                    next: (output) => progress.report({ message: output.out }),
                    error: (err) => {
                        console.error('Error occurred:', err);
                    },
                    complete: () => resolve(),
                });
            });

            const condaInfo = await conda.getInfo();
            const firstEnvDir = condaInfo.envs_dirs && condaInfo.envs_dirs.length > 0 ? condaInfo.envs_dirs[0] : undefined;

            // ----------------------------part.2 项目空间拉取的环境------------
            if (firstEnvDir) {
                console.info(`conda envs dir: ${firstEnvDir}`)
                // tar -xvzf my_environment.tar.gz -C /opt/my_environment --strip-components=1
                // unpackCondaEnvironment(localTmpTar, `${firstEnvDir}/${env.environment?.name}`)
                //     .then(() => {
                //         console.log('Environment unpacked successfully.');
                //     })
                //     .catch((error) => {
                //         console.error('Failed to unpack environment:', error);
                //     });
                // if (fs.existsSync(localTmpTar)) {
                //     // 删除已存在的文件
                //     console.log('Environment download successfully. Delete tmp data.');
                //     fs.unlinkSync(localTmpTar);
                // }

                try {
                    await unpackCondaEnvironment(localTmpTar, `${firstEnvDir}/${env.environment?.name}`);
                    console.log('Environment unpacked successfully.');

                    if (fs.existsSync(localTmpTar)) {
                        // 删除已存在的文件
                        console.log('Environment download successfully. Delete tmp data.');
                        fs.unlinkSync(localTmpTar);
                    }
                } catch (error) {
                    console.error('Failed to unpack environment:', error);
                }
            }

        })
        .catch((error) => {
            console.error('Failed to fetch environment meta:', error);
        });

    // const result = execObservable("cp", ["-r", `/tmp/${env.environment?.name}.tar.gz`, "~/.conda/envs/"], { timeout: 60_000 });
    // await new Promise<void>((resolve) => {
    //     result.out.subscribe({
    //         next: (output) => progress.report({ message: output.out }),
    //         error: (err) => {
    //             console.error('Error occurred:', err);
    //         },
    //         complete: () => resolve(),
    //     });
    // });

    return {
        envName: env.environment?.name
    }
}

type ExtractItemType<T> = T extends (QuickPickItem & { item: infer R })[] ? (R | undefined) : undefined;
type SearchPackageResult =
    | {
        conda: ExtractItemType<Awaited<ReturnType<typeof searchCondaPackage>>>;
    }
    | {
        poetry: ExtractItemType<Awaited<ReturnType<typeof searchPoetryPackage>>>;
    }
    | {
        pip: ExtractItemType<Awaited<ReturnType<typeof searchPipPackage>>>;
    };

export async function searchPackage(env: Environment): Promise<SearchPackageResult> {
    try {
        if (isCondaEnvironment(env)) {
            const result = await searchPackageWithProvider(searchCondaPackage, env);
            if (!result) {
                throw new CancellationError();
            }
            return { conda: result };
        }
        if (getEnvironmentType(env) === EnvironmentType.Poetry) {
            const result = await searchPackageWithProvider(searchPoetryPackage, env);
            if (!result) {
                throw new CancellationError();
            }
            return { poetry: result };
        }
        const result = await searchPackageWithProvider(searchPipPackage, env);
        if (!result) {
            throw new CancellationError();
        }
        return { pip: result };
    } catch (ex) {
        traceError(`Failed to install a package in ${env.id})`, ex);
        throw ex;
    }
}
export async function installPackage(env: Environment, packageInfo: SearchPackageResult) {
    let packageName = '';
    if ('conda' in packageInfo && packageInfo.conda) {
        packageName = packageInfo.conda.name;
    } else if ('poetry' in packageInfo && packageInfo.poetry) {
        packageName = packageInfo.poetry;
    } else if ('pip' in packageInfo && packageInfo.pip) {
        packageName = packageInfo.pip.name;
    } else {
        throw new Error('Not supported');
    }

    await window.withProgress(
        { location: ProgressLocation.Notification, cancellable: true, title: `Installing ${packageName}` },
        async (progress, token) => {
            let result: {
                command: string;
                args: string[];
                options?: SpawnOptions | undefined;
            };
            try {
                if ('conda' in packageInfo && packageInfo.conda) {
                    result = await getCondaPackageInstallSpawnOptions(env, packageInfo.conda, token);
                } else if ('poetry' in packageInfo && packageInfo.poetry) {
                    result = await getPoetryPackageInstallSpawnOptions(env, packageInfo.poetry, token);
                } else if ('pip' in packageInfo && packageInfo.pip) {
                    result = await getInstallPipPackageSpawnOptions(env, packageInfo.pip, token);
                } else {
                    throw new Error('Not supported');
                }
                const message = `Installing package ${packageName} into ${getEnvLoggingInfo(env)} with command ${[
                    result.command,
                    ...result.args,
                ]}]}`;
                await reportStdOutProgress(
                    message,
                    [result.command, result.args, { timeout: 60_000, ...(result.options || {}) }],
                    progress,
                    token,
                );
            } catch (ex) {
                traceError(`Failed to install package ${packageName} into ${getEnvLoggingInfo(env)})`, ex);
            }
        },
    );
}
