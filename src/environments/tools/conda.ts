import { Environment, PythonExtension, ResolvedEnvironment } from '@vscode/python-extension';
import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { EOL } from 'os';
import { CancellationToken, Progress, ProgressLocation, QuickPickItem, window } from 'vscode';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ApplicationShell } from '../../client/common/application/applicationShell';
import { execObservable } from '../../client/common/process/rawProcessApis';
import { InputStep, MultiStepInput } from '../../client/common/utils/multiStepInput';
import { getUserHomeDir } from '../../client/common/utils/platform';
import { traceError, traceInfo, traceVerbose } from '../../client/logging';
import { Conda } from '../../client/pythonEnvironments/common/environmentManagers/conda';
import { exec } from '../../client/pythonEnvironments/common/externalDependencies';
import { getDisplayPath, getEnvDisplayInfo, getEnvLoggingInfo, home } from '../helpers';
import { MICROMAMBA_ROOTPREFIX } from '../micromamba/constants';
import { isCondaEnvironment } from '../utils';
import { SpawnOptions } from '../../client/common/process/types';
import ContextManager, { PySparkParam } from '../../client/pythonEnvironments/info';

export type CondaPackageInfo = {
    // eslint-disable-next-line camelcase
    base_url?: string;
    // eslint-disable-next-line camelcase
    build_number?: number;
    // eslint-disable-next-line camelcase
    build_string?: string;
    channel?: string;
    // eslint-disable-next-line camelcase
    dist_name?: string;
    name: string;
    platform?: string;
    version: string;
};

type OutdatedPackageInfo = {
    actions: {
        FETCH: { version: string; name: string }[];
        LINK: { version: string; name: string }[];
        UNLINK: { version: string; name: string }[];
    };
};

export async function getCondaPackages(env: Environment) {
    if (!isCondaEnvironment(env) || !env.executable.uri) {
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }
    const args = ['list'].concat(
        env.environment?.name
            ? ['-n', env.environment.name]
            : ['-p', env.environment?.folderUri?.fsPath || path.dirname(env.path)],
    );
    const result = await exec(conda.command, args.concat(['--json']), { timeout: 60_000 });
    const stdout = result.stdout.trim();
    traceVerbose(`conda info --json: ${result.stdout}`);
    const packages = stdout ? (JSON.parse(result.stdout) as CondaPackageInfo[]) : [];
    return packages;
}
export async function getOutdatedCondaPackages(env: Environment): Promise<Map<string, string> | undefined> {
    if (!isCondaEnvironment(env) || !env.executable.uri) {
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }

    const args = ['update', '--all', '-d'].concat(
        env.environment?.name
            ? ['-n', env.environment.name]
            : ['-p', env.environment?.folderUri?.fsPath || path.dirname(env.path)],
    );
    const result = await exec(conda.command, args.concat(['--json']), { timeout: 60_000 });
    const stdout = result.stdout.trim();
    traceVerbose(`conda ${args.join(' ')} --json: ${result.stdout}`);
    if (!stdout) {
        return;
    }
    const map = new Map<string, string>();
    const unlink = new Set<string>();
    const { actions } = JSON.parse(result.stdout) as OutdatedPackageInfo;
    actions.UNLINK.forEach((pkg) => unlink.add(pkg.name));
    actions.LINK.forEach((pkg) => {
        if (unlink.has(pkg.name)) {
            map.set(pkg.name, pkg.version);
        }
    });

    return map;
}
export async function updateCondaPackages(env: Environment) {
    if (!isCondaEnvironment(env) || !env.executable.uri) {
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }

    const args = ['update', '--all'].concat(
        env.environment?.name
            ? ['-n', env.environment.name]
            : ['-p', env.environment?.folderUri?.fsPath || path.dirname(env.path)],
    );
    await exec(conda.command, args, { timeout: 60_000 });
}
export async function getUninstallCondaPackageSpawnOptions(
    env: Environment,
    pkg: CondaPackageInfo,
    _token: CancellationToken,
): Promise<{ command: string; args: string[]; options?: SpawnOptions }> {
    if (!isCondaEnvironment(env) || !env.executable.uri) {
        throw new Error('Not Supported');
    }
    const conda = await Conda.getConda();
    if (!conda) {
        throw new Error('Not Supported');
    }

    const args = ['remove', pkg.name, '-y'].concat(
        env.environment?.name
            ? ['-n', env.environment.name]
            : ['-p', env.environment?.folderUri?.fsPath || path.dirname(env.path)],
    );
    return { command: conda.command, args };
}
export async function updateCondaPackage(env: Environment, pkg: CondaPackageInfo) {
    if (!isCondaEnvironment(env) || !env.executable.uri) {
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }

    const args = ['update', pkg.name, '-y'].concat(
        env.environment?.name
            ? ['-n', env.environment.name]
            : ['-p', env.environment?.folderUri?.fsPath || path.dirname(env.path)],
    );
    await exec(conda.command, args, { timeout: 60_000 });
}

export async function deleteEnv(
    env: Environment | ResolvedEnvironment,
    progress: Progress<{ message?: string | undefined; increment?: number | undefined }>,
) {
    if (!isCondaEnvironment(env)) {
        traceError(`Cannot delete as its not a conda environment or no name/path for ${getEnvLoggingInfo(env)}`);
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }
    const args = env.environment?.name
        ? ['-n', env.environment.name]
        : ['-p', env.environment?.folderUri?.fsPath || env.path];
    const message = `Deleting conda environment ${getEnvLoggingInfo(env)} with command ${[
        conda.command,
        'env',
        'remove',
    ]
        .concat(args)
        .join(' ')}`;
    traceVerbose(message);
    progress.report({ message });
    const result = await execObservable(conda.command, ['env', 'remove'].concat(args), { timeout: 60_000 });
    await new Promise<void>((resolve) => {
        result.out.subscribe({
            next: (output) => progress.report({ message: output.out }),
            error: (err) => {
                console.error('Error occurred:', err);
            },
            complete: () =>
                resolve(),
        });
    });
    // // Check if it was deleted successfully.
    if (await fs.pathExists(env.path)) {
        throw new Error(
            `Failed to delete conda environment ${getEnvDisplayInfo(env)}, folder still exists ${getDisplayPath(
                env.path,
            )} `,
        );
    }
}

// export async function packageCondaEnv(
//     env: Environment | ResolvedEnvironment,
//     progress: Progress<{ message?: string | undefined; increment?: number | undefined; }>,
// ) {
//     if (!isCondaEnvironment(env)) {
//         traceError(`Cannot delete as its not a conda environment or no name/path for ${getEnvLoggingInfo(env)}`);
//         return;
//     }
//     const conda = await Conda.getConda();
//     if (!conda) {
//         return;
//     }
//     const args = env.environment?.name
//         ? ['-n', env.environment.name]
//         : ['-p', env.environment?.folderUri?.fsPath || env.path];
//     const message = `Download python environment ${getEnvLoggingInfo(env)} with command ${[
//         conda.command,
//         'env',
//         'remove',
//     ]
//         .concat(args)
//         .join(' ')}`;
//     traceVerbose(message);
//     progress.report({ message });
//     const proId = 1;
//     const hdfsDir = "/dsp/python_env_resource/";
//     const envName = `pri_${proId}_${env.environment?.name}.tar.gz`
//     const filePath = `/tmp/${envName}`;
//     if (fs.existsSync(filePath)) {
//         // 删除已存在的文件
//         fs.unlinkSync(filePath);
//     }

//     console.log(`start package env: conda-pack ${args.concat(['-o', filePath])}`)
//     // 打包到本地/tmp/xxx-uuid.tar.gz
//     const result = execObservable("conda-pack", args.concat(['-o', filePath]), { timeout: 600_000 });
//     await new Promise<void>((resolve) => {
//         result.out.subscribe({
//             next: (output) => progress.report({ message: output.out }),
//             error: (err) => {
//                 console.error('Error occurred:', err);
//             },
//             complete: () => resolve(),
//         });
//     });
//     // TODO:  
//     // const DSP_USER = `${process.env.DSP_USER}`;
//     // if (!DSP_USER) {
//     //     DSP_USER = "yixiao.chang"
//     // }

//     // // 刷新keytab
//     // execObservable("python", args.concat(["/home/finance/.krb5/get_keytab2.py", "http://dwmetaapidsp.msxf.lo exkeytab", "exkeytab", "b236c9b6b9f34ade", DSP_USER, `/home/finance/.krb5/${DSP_USER}.keytab`]), { timeout: 600_000 });
//     // await new Promise<void>((resolve) => {
//     //     result.out.subscribe({
//     //         next: (output) => progress.report({ message: output.out }),
//     //         error: (err) => {
//     //             console.error('Error occurred:', err);
//     //         },
//     //         complete: () => resolve(),
//     //     });
//     // });
//     // // 初始化票据
//     // execObservable("kinit", args.concat(["-kt", `/tmp/${DSP_USER}.keytab ${DSP_USER}`]), { timeout: 600_000 });
//     // await new Promise<void>((resolve) => {
//     //     result.out.subscribe({
//     //         next: (output) => progress.report({ message: output.out }),
//     //         error: (err) => {
//     //             console.error('Error occurred:', err);
//     //         },
//     //         complete: () => resolve(),
//     //     });
//     // });

//     // 上传到hdfs临时目录
//     // execObservable("hdfs", ["dfs", "-put", filePath, "/tmp/"], { timeout: 600_000 });
//     // await new Promise<void>((resolve) => {
//     //     result.out.subscribe({
//     //         next: (output) => progress.report({ message: output.out }),
//     //         error: (err) => {
//     //             console.error('Error occurred:', err);
//     //         },
//     //         complete: () => resolve(),
//     //     });
//     // });

//     // 使用该函数的示例
//     (async () => {

//         try {
//             await hdfsPutCommand(filePath, "/tmp/");
//             console.log('File has been successfully uploaded to HDFS.');
//         } catch (error) {
//             console.error('Error uploading file to HDFS:', error);
//         }
//     })();

//     if (env.environment?.name) {
//         // 请求gateway，移动环境包至正式目录
//         uploadEnvironmentPackage(1, env.environment?.name, `/tmp/${envName}`, hdfsDir)
//             .then(response => console.log('Upload response:', response))
//             .catch(error => console.error('Error:', error));
//     }

//     fs.unlinkSync(filePath);

//     return {
//         envName: env.environment?.name,
//         filePath,
//         hdfsDir: `${hdfsDir}${envName}`
//     }
// }

export async function packageCondaEnv(
    env: Environment | ResolvedEnvironment,
    progress: Progress<{ message?: string | undefined; increment?: number | undefined; }>,
    condaYml: string
): Promise<{ envName?: string; localFilePath: string; hdfsDir: string } | undefined> {
    if (!env.environment?.name) {
        console.error('Environment name is not defined.');
        return;
    }
    if (!isCondaEnvironment(env)) {
        traceError(`Cannot delete as its not a conda environment or no name/path for ${getEnvLoggingInfo(env)}`);
        return;
    }
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }
    const args = env.environment?.name
        ? ['-n', env.environment.name]
        : ['-p', env.environment?.folderUri?.fsPath || env.path];
    const message = `Download python environment ${getEnvLoggingInfo(env)} with command ${[
        conda.command,
        'env',
        'remove',
    ]
        .concat(args)
        .join(' ')}`;
    traceVerbose(message);
    progress.report({ message });

    // 生成一个 UUID
    const uniqueId = uuidv4();
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
        return;
    }

    // 查询是否有可复用的包，如果存在，后面的打包都可以不执行了
    const checkResult = await checkReusableEnvironment(condaYml);
    if (checkResult.exists) {
        return {
            envName: env.environment?.name,
            localFilePath: "",
            hdfsDir: checkResult.environmentDirectory
        };
    }

    let finalEnvHdfsDir = "hdfs://dptestservice1/dsp/python_env_resource/";
    let tmpEnvHdfsPath = "hdfs://dptestservice1/tmp/";
    const runEnv = process.env.RUN_ENV;

    if (runEnv === 'online') {
        console.log('当前运行环境: online');
        finalEnvHdfsDir = "hdfs://ms-dwh/dsp/python_env_resource/";
        tmpEnvHdfsPath = "hdfs://ms-dwh/tmp/"
    } else {
        console.log('当前运行环境: 非 online');
    }

    const envName = `pri_${proId}_${env.environment?.name}.tar.gz`
    const filePath = `/tmp/${uniqueId}_${envName}`;

    console.log(`start package env: conda-pack ${args.concat(['-o', filePath])}`);

    try {
        const result = execObservable("conda-pack", args.concat(['-o', filePath]), { timeout: 600_000 });
        await new Promise<void>((resolve, reject) => {
            result.out.subscribe({
                next: (output) => progress.report({ message: output.out }),
                error: (err) => {
                    console.error('Error occurred:', err);
                    // 错误处理逻辑，如果 error 事件发生，reject 会被调用，并且抛出一个异常，从而中断了 await 后面的代码的执行。
                    reject(new Error(`Failed to package environment: ${err}`)); // 抛出异常
                },
                complete: () => resolve(),
            });
        });

        // 如果代码运行到这里，说明打包成功，继续处理
        await hdfsPutCommand(filePath, tmpEnvHdfsPath);

        // 如果 hdfsPutCommand 成功执行，则会继续执行下面的代码
        // 调用 uploadEnvironmentPackage 并等待其完成
        const uploadResult = await uploadEnvironmentPackage(proId, envName, filePath, `/dsp/python_env_resource/${envName}`);

        // 检查返回的响应状态
        if (uploadResult.status === 'failed') {
            throw new Error(`Failed to upload environment package: ${uploadResult.message}`);
        }

        // 删除临时文件
        fs.unlinkSync(filePath);
        await hdfsRmCommand(filePath);
        return {
            envName: env.environment?.name,
            localFilePath: `${tmpEnvHdfsPath}${uniqueId}_${envName}`,
            hdfsDir: `${finalEnvHdfsDir}${envName}`
        };

    } catch (error) {
        // 使用类型断言将 error 转换为 Error 类型
        const errorMessage = (error as Error).message;
        traceError(`Error packaging conda environment: ${errorMessage}`);
        window.showErrorMessage(`Error packaging conda environment: ${errorMessage}`);
        throw error; // 抛出错误，确保外层捕获并停止进度条
    }
}

interface ReusableEnvironmentResponse {
    exists: boolean;
    environmentDirectory: string;
    envName: string;
}

async function checkReusableEnvironment(
    textContent: string
): Promise<ReusableEnvironmentResponse> {
    try {
        const url = `${ContextManager.getInstance().getContext().globalState.get<string>('gateway.addr')}/api/v1/env/pyspark/reusable-environment-check`;

        const data = {
            projectId: -1, // Mandatory field
            metadata: {
                textContent, // Pass the textContent parameter here
            },
        };

        const response = await axios.post(url, data, {
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw;ide_admin=1',
                'Content-Type': 'application/json',
                'operator': 'hu.tan@msxf.com',
            },
        });

        // Successful request, return the response
        return response.data as ReusableEnvironmentResponse;

    } catch (error) {
        // Log the error message
        console.error('Error checking reusable environment:', error);

        // Return a default error response
        return { exists: false, environmentDirectory: '', envName: '' };
    }
}


// 定义一个函数来执行 HDFS dfs -put 命令
async function hdfsPutCommand(localFilePath: string, hdfsDestination: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // 使用 spawn 来执行 hdfs dfs -put 命令
        const hdfsPut = spawn('hdfs', ['dfs', '-put', localFilePath, hdfsDestination]);

        // 处理标准输出
        hdfsPut.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });

        // 处理标准错误输出
        hdfsPut.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        // 处理命令完成的情况
        hdfsPut.on('close', (code) => {
            if (code === 0) {
                console.log(`HDFS put command executed successfully.`);
                resolve();
            } else {
                reject(new Error(`HDFS put command exited with code ${code}`)); // 使用 reject 抛出异常
            }
        });

        // 处理命令执行中的错误
        hdfsPut.on('error', (err) => {
            console.error(`Failed to start HDFS put command: ${err}`);
            reject(new Error(`Failed to start HDFS put command: ${err.message}`)); // 使用 reject 抛出异常
        });
    });
}


// 定义一个函数来执行 HDFS dfs -rm 命令
async function hdfsRmCommand(hdfsDestination: string): Promise<void> {
    console.log(`delete tmp hdfs env tar: ${hdfsDestination}`);
    return new Promise((resolve, reject) => {
        // 使用 spawn 来执行 hdfs dfs -rm 命令
        const hdfsRm = spawn('hdfs', ['dfs', '-rm', hdfsDestination]);

        // 处理标准输出
        hdfsRm.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });

        // 处理标准错误输出
        hdfsRm.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        // 处理命令完成的情况
        hdfsRm.on('close', (code) => {
            if (code === 0) {
                console.log(`HDFS rm command executed successfully.`);
                resolve();
            } else {
                reject(new Error(`HDFS rm command exited with code ${code}`));
            }
        });

        // 处理命令执行中的错误
        hdfsRm.on('error', (err) => {
            console.error(`Failed to start HDFS rm command: ${err}`);
            reject(err);
        });
    });
}

interface UploadResponse {
    message: string;
    status: string;
}

async function uploadEnvironmentPackage(
    proId: string,
    name: string,
    srcPath: string,
    targetPath: string
): Promise<UploadResponse> {
    try {
        const url = `${ContextManager.getInstance().getContext().globalState.get<string>('gateway.addr')}/api/v1/env/pyspark/${proId}/environment-packages/upload`;

        const data = {
            name,
            src_path: srcPath,
            target_path: targetPath
        };

        const response = await axios.post(url, data, {
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw;ide_admin=1',
                'Content-Type': 'application/json',
                'operator': 'hu.tan@msxf.com'
            }
        });

        // 成功请求，返回服务器的响应
        return response.data as UploadResponse;

    } catch (error) {
        // 捕获到错误，打印错误信息
        console.error('Error uploading environment package:', error);

        // 返回默认失败的响应
        return { message: `上传失败: ${error}`, status: 'failed' };
    }
}

export async function getCondaVersion() {
    const conda = await Conda.getConda();
    if (!conda) {
        return;
    }
    return conda.getInfo().catch((ex) => traceError('Failed to get conda info', ex));
}

function getLatestCondaPythonVersion(environments: readonly Environment[]) {
    let maxMajorVersion = 3;
    let maxMinorVersion = 9;
    environments
        .filter((env) => isCondaEnvironment(env))
        .forEach((env) => {
            if (!env.version?.major || env.version?.major < maxMajorVersion) {
                // Noop,
            } else if (env.version?.major > maxMajorVersion) {
                maxMajorVersion = env.version?.major;
                maxMinorVersion = env.version?.minor || 0;
            } else if ((env.version?.minor || 0) > maxMinorVersion) {
                maxMinorVersion = env.version?.minor || 0;
            }
        });
    return `${maxMajorVersion}.${maxMinorVersion}`;
}
export async function createEnv() {
    const api = await PythonExtension.api();
    const conda = await Conda.getConda();
    if (!conda) {
        traceError(`Conda not found`);
        return;
    }

    type StateType = { name: string; pythonVersion?: string };
    const initialState: StateType = { name: '' };
    const availableMaxPythonVersion = getLatestCondaPythonVersion(api.environments.known);
    const selectVersion = async (
        input: MultiStepInput<StateType>,
        state: StateType,
    ): Promise<InputStep<StateType> | void> => {
        const version = await input.showInputBox({
            title: 'Select Python Version',
            validate: async (value) => {
                if (!value.trim().length) {
                    return 'Enter a Python version such as 3.9';
                }
            },
            placeholder: '3.7, 3.8, 3.9, 3.10, etc',
            prompt: 'Python Version',
            value: availableMaxPythonVersion,
        });
        state.pythonVersion = version?.trim();
    };

    const specifyName = async (
        input: MultiStepInput<StateType>,
        state: StateType,
    ): Promise<InputStep<StateType> | void> => {
        const name = await input.showInputBox({
            title: 'Enter the name of the virtual environment',
            value: '.venv',
            step: 1,
            totalSteps: 3,
            prompt: 'Name',
            validate: async (value) => {
                if (!value) {
                    return 'Enter a name';
                }
            },
        });
        if (name) {
            state.name = name.trim();
            return selectVersion(input, state);
        }
    };

    const multistepInput = new MultiStepInput<StateType>(new ApplicationShell());
    await multistepInput.run(specifyName, initialState);

    // Verify we completed.
    if (!initialState.name.trim() || !initialState.pythonVersion) {
        return;
    }
    await window.withProgress(
        {
            location: ProgressLocation.Notification,
            cancellable: true,
            title: `Creating environment '${initialState.name.trim()}'`,
        },
        async (uiProgress, token) => {
            await createEnvWithInfo(
                uiProgress,
                token,
                initialState.name.trim(),
                conda.command,
                initialState.pythonVersion,
            );
        },
    );
}

async function createEnvWithInfo(
    progress: Progress<{
        message?: string | undefined;
        increment?: number | undefined;
    }>,
    token: CancellationToken,
    name: string,
    condaFile: string,
    pythonVersion = '3.9',
) {
    try {
        const isMicroMamba = condaFile.includes('.micromamba');
        progress.report({ message: `Creating environment ${name}` });
        traceInfo(`Creating conda environment ${name} with python version ${pythonVersion}`);
        const extraCreationArgs = isMicroMamba ? ['-c', 'conda-forge'] : [];
        const args = ['create', `-n`, `${name.trim()}`, `python=${pythonVersion || '3.9'}`]
            .concat(extraCreationArgs)
            .concat(['-y']);
        traceInfo([condaFile].concat(args).join(' '));
        const result = await execObservable(condaFile, args, {
            timeout: 120_000,
            token,
        });
        result.proc?.on('error', (ex) => console.error(`Conda create exited with an error`, ex));
        await new Promise<void>((resolve, reject) => {
            result.out.subscribe({
                next: (output) => {
                    if (output.out.trim().length) {
                        progress.report({ message: output.out });
                    }
                    traceInfo(output.out);
                },
                complete: () => resolve(),
                error: (ex) => reject(ex),
            });
        });

        if (isMicroMamba) {
            await updateEnvironmentsTxt(path.join(MICROMAMBA_ROOTPREFIX, name.trim())).catch((ex) =>
                traceError('Failed to update environments.txt', ex),
            );
        }

        progress.report({ message: 'Waiting for environment to be detected' });
        const api = await PythonExtension.api();
        await api.environments.refreshEnvironments();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (ex) {
        traceError(`Failed to create environment`, ex);
        window.showErrorMessage(`Failed to create environment ${name}, ${ex}`);
    }
}

export async function updateEnvironmentsTxt(envFolder: string) {
    const txtFile = path.join(getUserHomeDir() || home, '.conda', 'environments.txt');
    const contents = await fs.readFile(txtFile, 'utf-8');
    if (contents.includes(envFolder)) {
        return;
    }
    await fs.writeFile(txtFile, `${contents.trim()}${EOL}${envFolder}${EOL}`);
}

/**
 * 导出指定的 conda 环境配置
 * @param name - conda 环境的名称
 * @returns Promise<string> - 导出环境配置的字符串
 */
export async function exportCondaEnv(name: string): Promise<string> {
    const conda = await Conda.getConda();
    if (!conda) {
        traceError(`Conda not found`);
        return "";
    }

    const result = await exec(
        conda.command,
        ['env', 'export', '-n', name],
        { timeout: 60_000 },
    );
    return result.stdout;
}


export async function exportCondaPackages(env: Environment | ResolvedEnvironment) {
    const conda = await Conda.getConda();
    if (!conda) {
        traceError(`Conda not found`);
        return;
    }

    if (!env.executable.sysPrefix) {
        return;
    }
    const result = await exec(
        conda.command,
        ['env', 'export', '-p', env.executable.sysPrefix.fileToCommandArgumentForPythonMgrExt()],
        { timeout: 60_000 },
    );
    return { contents: result.stdout, language: 'yaml', file: 'environment.yml' };
}
export async function getCondaPackageInstallSpawnOptions(
    env: Environment | ResolvedEnvironment,
    packageInfo: { name: string; channel?: string; version: string },
    _token: CancellationToken,
) {
    const conda = await Conda.getConda();
    if (!conda) {
        throw new Error(`Conda not found`);
    }

    if (!env.executable.sysPrefix) {
        throw new Error(`Invalid Conda Env`);
    }
    const args = ['install'];
    if (packageInfo.channel) {
        args.push('-c', packageInfo.channel);
    }
    args.push(`${packageInfo.name}==${packageInfo.version}`);
    args.push('-p', env.executable.sysPrefix.fileToCommandArgumentForPythonMgrExt(), '-y');
    return { command: conda.command, args };
}

export async function searchCondaPackage(
    value: string,
    _env: Environment,
    token: CancellationToken,
): Promise<(QuickPickItem & { item: { name: string; version: string; channel: string } })[]> {
    try {
        const conda = await Conda.getConda();
        if (!conda) {
            traceError(`Conda not found`);
            return [];
        }

        const message = `Searching for Conda packages with command ${[
            conda.command,
            'search',
            '-f',
            value,
        ]}]}`;
        traceVerbose(message);
        const result = await exec(conda.command, ['search', '-f', value], { timeout: 60_000, token });
        const lines = result.stdout
            .split(/\r?\n/g)
            .filter((line) => line.trim().length)
            .filter((line) => !line.startsWith('Loading channels: done'))
            .filter((line) => !line.startsWith('# Name'));
        if (lines.length === 0) {
            return [];
        }
        const items: (QuickPickItem & { item: { name: string; version: string; channel: string } })[] = [];
        const addedItems = new Set<string>();
        lines.forEach((line) => {
            const parts = line
                .split(' ')
                .map((p) => p.trim())
                .filter((p) => p.length);
            if (parts.length !== 4) {
                return;
            }
            const key = `${parts[0]}-${parts[1]}-${parts[3]}`;
            if (addedItems.has(key)) {
                return;
            }
            addedItems.add(key);
            const item = { name: parts[0], version: parts[1], channel: parts[3] };
            items.push({ label: item.name, description: `${item.version} (${item.channel})`, item });
        });
        return items.reverse();
    } catch (ex) {
        traceError(`Failed to search for package`, ex);
        return [];
    }
}
