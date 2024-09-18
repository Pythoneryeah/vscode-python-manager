import { CancellationToken, commands, ExtensionContext, Progress, ProgressLocation, window } from 'vscode';
import axios from 'axios';
import { execSync } from 'child_process';
import { EnvironmentWrapper } from './view/types';
import { getEnvDisplayInfo, getEnvLoggingInfo } from './helpers';
import { exportCondaEnv, packageCondaEnv } from './tools/conda';

import { traceError } from '../client/logging';
import { withProgress } from '../client/common/vscodeApis/windowApis';
import CacheMap from '../client/pythonEnvironments/common/windowsUtils';

export function activate(context: ExtensionContext) {
    context.subscriptions.push(
        commands.registerCommand(
            'python.envManager.submitEnv',
            async (options: EnvironmentWrapper) => {

                const name = options.env.environment?.name
                if (!options.env.version) {
                    // Handle unknown version case
                    console.log("Version is unknown.");
                    window.showErrorMessage(`环境 ${name} 的 python 版本异常`);
                    return;
                }

                const version = `${options.env.version.major}.${options.env.version.minor}.${options.env.version.micro}`;
                if (options.env.version.major !== 3) {
                    // Handle unknown version case
                    console.log(`Version is invalid. ${version}}`);
                    window.showErrorMessage(`环境 ${name} 的 python 版本为 ${version}, 当前仅支持 python3。`);
                    return;
                }



                const message = `确定要提交环境 '${getEnvDisplayInfo(options.env)}' 吗？`;
                const detail = `上传'${getEnvDisplayInfo(options.env)}' 至项目空间。`;
                if ((await window.showInformationMessage(message, { modal: true, detail }, 'Yes')) !== 'Yes') {
                    return;
                }

                console.log(`1111111111 ${getEnvDisplayInfo(options.env)}`)
                console.log("1. 获取环境的name......")
                console.log(`1111111111 ${name}`)
                if (!name) {
                    return;
                }
                console.log("2. 获取环境的yaml......")
                const condaYml = await exportCondaEnv(name)
                console.log(`3. 获取环境的yaml......yml content: ${condaYml}`)
                console.log("4. 请求gateway接口，查询环境是否重名")
                if (!name) {
                    return window.showErrorMessage(`环境元数据异常~`);
                }

                const projectId = CacheMap.getInstance().get('projectId');
                const projectCode = CacheMap.getInstance().get('projectCode');

                let proId = '0';
                // 检查是否成功获取到数据
                // if (pySparkParam) {
                if (projectId && projectCode) {
                    // 通过属性名获取 projectId 和 projectCode
                    // const { projectId } = pySparkParam;
                    // const { projectCode } = pySparkParam;

                    console.log(`fetchEnvironments Project ID: ${projectId}`);
                    console.log(`fetchEnvironments Project Code: ${projectCode}`);
                    proId = projectId;
                    // if (projectId) {
                    //     proId = projectId;
                    // }
                } else {
                    console.log('No PySparkParam found in global state. 1');
                    window.showErrorMessage(`环境 ${name} 提交失败：No PySparkParam found in global state.`);
                    return;
                }

                // 请求 gateway，检测环境是否已存在
                const checkResult = await checkEnvironmentName(proId, name, condaYml);
                console.log('Check name result:', checkResult);
                if (checkResult) {
                    console.log('Environment name is available.');
                    if (checkResult === name) {
                        window.showErrorMessage(`环境 ${name} 提交失败, 环境命名冲突。`);
                    } else {
                        window.showErrorMessage(`环境 ${name} 提交失败, 该项目空间中已经存在相同的环境包 ${checkResult} `);
                    }
                    return; // Terminate execution if result is truthy
                }

                console.log("5. 打包....")
                // conda pack -n myenv' -o 'myenv.tar.gz'"

                // try {
                //     await withProgress(
                //         {
                //             location: ProgressLocation.Notification,
                //             title: `提交环境 ${getEnvDisplayInfo(options.env)}`,
                //             cancellable: true,
                //         },
                //         async (
                //             progress: Progress<{ message?: string | undefined; increment?: number | undefined }>,
                //             _token: CancellationToken,
                //         ) => {
                //             console.log("push env.....");
                //             const result = await packageCondaEnv(options.env, progress);
                //             if (result) {
                //                 const { envName, filePath, hdfsDir } = result;
                //                 // 使用filePath
                //                 console.log(`提交至项目空间：${envName}, ${filePath}}, ${hdfsDir}...`)

                //                 const environmentData: EnvironmentData = {
                //                     proId,
                //                     name: `${envName}`,
                //                     hdfsPath: `${hdfsDir}`,
                //                     detail: `${condaYml}`,
                //                     createBy: `${process.env.DSP_USER}`,
                //                     level: 1
                //                 };

                //                 submitEnvironmentData(environmentData)
                //                     .then(response => {
                //                         console.log('Response:', response);
                //                     })
                //                     .catch(error => {
                //                         console.error('Request failed:', error);
                //                     });
                //             } else {
                //                 // 处理结果为undefined的情况
                //             }
                //         },
                //     );

                //     return commands.executeCommand('python.envManager.refresh', true);
                //     // eslint-disable-next-line @typescript-eslint/no-explicit-any
                // } catch (ex) {
                //     traceError(`环境 ${getEnvLoggingInfo(options.env)} 提交失败`, ex);
                //     return window.showErrorMessage(`环境 ${getEnvDisplayInfo(options.env)} 提交失败, ${ex}`);
                // }

                try {
                    await withProgress(
                        {
                            location: ProgressLocation.Notification,
                            title: `提交环境 ${getEnvDisplayInfo(options.env)}`,
                            cancellable: true,
                        },
                        async (
                            progress: Progress<{ message?: string | undefined; increment?: number | undefined; }>,
                            _token: CancellationToken
                        ) => {
                            console.log("push env.....");
                            const result = await packageCondaEnv(options.env, progress, condaYml);
                            if (result) {
                                const { envName, localFilePath, hdfsDir } = result;
                                console.log(`提交至项目空间：${envName}, ${localFilePath}}, ${hdfsDir}...`);

                                const environmentData: EnvironmentData = {
                                    proId,
                                    name: `${envName}`,
                                    hdfsPath: `${hdfsDir}`,
                                    detail: `${condaYml}`,
                                    createBy: getCreateBy(),
                                    level: 1,
                                    version,
                                };

                                await submitEnvironmentData(environmentData);
                            }
                        }
                    );

                    return commands.executeCommand('python.envManager.refresh', true);
                } catch (ex) {
                    // 同样在这里处理异常，确保类型是 Error
                    const errorMessage = (ex as Error).message;
                    traceError(`环境 ${getEnvLoggingInfo(options.env)} 提交失败: ${errorMessage}`);
                    return window.showErrorMessage(`环境 ${getEnvDisplayInfo(options.env)} 提交失败: ${errorMessage}`);
                }
            },
        ),
    );
}

function getCreateBy(): string {
    // 检查环境变量 DSP_USER 是否存在并且非空
    if (process.env.DSP_USER && process.env.DSP_USER.trim() !== '') {
        return process.env.DSP_USER;
    }
    // 如果不存在，则执行 whoami 命令
    try {
        const whoamiOutput = execSync('whoami', { encoding: 'utf-8' }).trim();
        return whoamiOutput;
    } catch (error) {
        console.error('no find user:', error);
        return 'unknown'; // 返回一个默认值，防止未捕获的错误
    }

}

export interface EnvironmentData {
    proId: string;
    name: string;
    hdfsPath: string;
    detail: string;
    createBy: string;
    level: number;
    version: string;
}

export async function submitEnvironmentData(data: EnvironmentData): Promise<{ success: boolean; message: string }> {
    try {
        const gatewayUri = CacheMap.getInstance().get("gatewayUri")
        console.log(`gatewayUri: ${gatewayUri}}`)
        const response = await axios.post(`${gatewayUri}/api/v1/env/pyspark/environments`, data, {
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw;ide_admin=1',
                'content-type': 'application/json',
                'operator': 'hu.tan@msxf.com'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error submitting environment data:', error);
        throw error;
    }
}

async function checkEnvironmentName(proId: string, name: string, condaYml: string): Promise<string> {
    try {
        const gatewayUri = CacheMap.getInstance().get("gatewayUri")
        console.log(`gatewayUri: ${gatewayUri}}`)
        const url = `${gatewayUri}/api/v1/env/pyspark/${proId}/environments/check-name`;

        const response = await axios.get(url, {
            params: { name, condaYml },
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw;ide_admin=1',
                'Content-Type': 'application/json',
                'operator': 'hu.tan@msxf.com'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Error checking environment name:', error);
        return ""; // 出现异常时返回 false
    }
}