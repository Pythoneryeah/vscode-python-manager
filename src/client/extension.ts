'use strict';

// This line should always be right on top.

if ((Reflect as any).metadata === undefined) {
    require('reflect-metadata');
}

//===============================================
// We start tracking the extension's startup time at this point.  The
// locations at which we record various Intervals are marked below in
// the same way as this.

const durations = {} as IStartupDurations;
import { StopWatch } from './common/utils/stopWatch';
// Do not move this line of code (used to measure extension load times).
const stopWatch = new StopWatch();

// Initialize file logging here. This should not depend on too many things.
const logDispose: { dispose: () => void }[] = [];

//===============================================
// loading starts here
import './common/extensions';
import { commands, NotebookCellData, NotebookCellKind, NotebookData, ProgressLocation, ProgressOptions, window, workspace } from 'vscode';
import { IDisposableRegistry, IExtensionContext } from './common/types';
import { createDeferred } from './common/utils/async';
import { Common } from './common/utils/localize';
import { activateComponents, activateFeatures } from './extensionActivation';
import { initializeStandard, initializeComponents, initializeGlobals } from './extensionInit';
import { IServiceContainer } from './ioc/types';
import { IStartupDurations } from './types';
import { disposeAll } from './common/utils/resourceLifecycle';
import { PySparkParam } from './pythonEnvironments/info';

durations.codeLoadingTime = stopWatch.elapsedTime;

//===============================================
// loading ends here

// These persist between activations:
let activatedServiceContainer: IServiceContainer | undefined;

/////////////////////////////
// public functions

export async function activate(context: IExtensionContext): Promise<void> {

    context.subscriptions.push(
        commands.registerCommand('pyspark.paramRegister', (pySparkParam: PySparkParam) => {
            console.log(`PySparkParam-python-env: ${JSON.stringify(pySparkParam)}`);
            commands.executeCommand('pyspark.paramRegister.copy', pySparkParam)

            // 设置 context
            console.log("set CacheMap.");
            const cache = CacheMap.getInstance();
            // 设置缓存值
            if (pySparkParam) {
                const { projectId } = pySparkParam;
                const { projectCode } = pySparkParam;
                cache.set('projectId', projectId);
                cache.set('projectCode', projectCode);
            } else {
                console.log('No PySparkParam found in global state. activate()');
                return;
            }

            let gatewayUri = "http://easdsp-gateway-bdpenv3-test.msxf.msxfyun.test";
            const runEnv = process.env.RUN_ENV;

            if (runEnv === 'online') {
                console.log('当前运行环境: online');
                gatewayUri = "http://easdsp-gateway.msxf.lo";
            } else {
                console.log('当前运行环境: 非 online');
            }
            cache.set("gatewayUri", gatewayUri)
        }),
    );

    // 生成pyspark模板
    context.subscriptions.push(
        // commands.registerCommand('pyspark.new.notebook', async () => {



        //     // 定义 Jupyter Notebook 模板内容
        //     const templateContent = {
        //         "cells": [
        //             {
        //                 "cell_type": "code",
        //                 "metadata": {},
        //                 "source": [
        //                     "# PySpark Initialization\n",
        //                     "from pyspark.sql import SparkSession\n",
        //                     "\n",
        //                     "# Create a Spark session\n",
        //                     "spark = SparkSession.builder.appName('PySpark Example').getOrCreate()\n",
        //                     "\n",
        //                     "# Your PySpark code goes here\n",
        //                     "data = [('Alice', 1), ('Bob', 2), ('Cathy', 3)]\n",
        //                     "df = spark.createDataFrame(data, ['Name', 'Value'])\n",
        //                     "df.show()\n"
        //                 ],
        //                 "outputs": [],
        //                 "execution_count": null,
        //             }
        //         ],
        //         "metadata": {
        //             "kernelspec": {
        //                 "display_name": "Python 3",
        //                 "language": "python",
        //                 "name": "python3"
        //             },
        //             "language_info": {
        //                 "codemirror_mode": {
        //                     "name": "ipython",
        //                     "version": 3
        //                 },
        //                 "file_extension": ".py",
        //                 "mimetype": "text/x-python",
        //                 "name": "python",
        //                 "nbconvert_exporter": "python",
        //                 "pygments_lexer": "ipython3",
        //                 "version": "3.8.8"
        //             }
        //         },
        //         "nbformat": 4,
        //         "nbformat_minor": 4
        //     };

        //     // 指定文件路径和文件名
        //     const filePath = path.join(workspace.workspaceFolders?.[0].uri.fsPath || '', 'pyspark.ipynb');

        //     // 将模板内容写入文件
        //     fs.writeFile(filePath, JSON.stringify(templateContent, null, 2), async (err) => {
        //         if (err) {
        //             window.showErrorMessage(`Failed to create notebook file: ${err.message}`);
        //             return;
        //         }

        //         // 打开生成的文件
        //         const doc = await workspace.openTextDocument(Uri.file(filePath));
        //         window.showTextDocument(doc);
        //     });
        // }),

        commands.registerCommand('pyspark.new.notebook', async () => {

            const language = 'python';
            // 在第一个单元格中添加 PySpark 初始化的代码
            let initialCode = `
# PySpark Initialization
from pyspark.sql import SparkSession

# Create a Spark session
spark = SparkSession.builder.appName('PySpark Example').getOrCreate()

# Sample data
data = [('Alice', 1), ('Bob', 2), ('Cathy', 3)]

# Create DataFrame
df = spark.createDataFrame(data, ['Name', 'Value'])

# Show DataFrame
df.show()
        `.trim();

            try {
                const result = await fetchPysparkTemplate('devdsp', 'source', 'pysparkNotebookTemplate');
                console.log('PySpark Template as String:', result);
                if (result) {
                    // // 先替换 \\n 为真正的换行符
                    // let formattedResult = result.replace(/\\n/g, '\n');
                    // // 去掉两端的双引号
                    // formattedResult = formattedResult.replace(/^"|"$/g, '');
                    // // 替换被转义的双引号 \" 为普通双引号 "
                    // formattedResult = formattedResult.replace(/\\"/g, '"');
                    initialCode = result;
                }
            } catch (error) {
                console.error('Error:', error);
            }

            // 创建一个新的笔记本单元格并填充初始代码
            const cell = new NotebookCellData(NotebookCellKind.Code, initialCode.trim(), language);

            // 创建笔记本数据对象，并添加第一个单元格
            const data = new NotebookData([cell]);

            // 设置笔记本元数据
            data.metadata = {
                custom: {
                    cells: [],
                    metadata: {},
                    nbformat: 4,
                    nbformat_minor: 2
                }
            };

            // 打开一个新的 Jupyter 笔记本文档
            const doc = await workspace.openNotebookDocument('jupyter-notebook', data);

            // 显示笔记本文档
            await window.showNotebookDocument(doc);
        }),

        commands.registerCommand('pyspark.new.pyFile', async () => {
            // 定义要填充的 PySpark 示例代码
            let pySparkExampleCode = `# PySpark f"{xx}"Initialization\nfrom pyspark.sql import SparkSession\n\n# Create a Spark session\nspark = SparkSession.builder.appName('PySpark Example').getOrCreate()\n\n# Sample data\ndata = [('Alice', 1), ('Bob', 2), ('Cathy', 3)]\n\n# Create DataFrame\ndf = spark.createDataFrame(data, ['Name', 'Value'])\n\n# Show DataFrame\ndf.show()`.trim();

            try {
                const result = await fetchPysparkTemplate('devdsp', 'source', 'pysparkFileTemplate');
                console.log('PySpark Template as String:', result);
                if (result) {
                    // 先替换 \\n 为真正的换行符
                    let formattedResult = result.replace(/\\n/g, '\n');
                    // 去掉两端的双引号
                    formattedResult = formattedResult.replace(/^"|"$/g, '');
                    // 替换被转义的双引号 \" 为普通双引号 "
                    formattedResult = formattedResult.replace(/\\"/g, '"');
                    pySparkExampleCode = formattedResult;
                }
            } catch (error) {
                console.error('fetch pysparkFileTemplate Error:', error);
            }

            // 创建一个新的 Python 文件并填充内容
            const newFile = await workspace.openTextDocument({ language: 'python', content: pySparkExampleCode });

            // 显示新建的文件
            window.showTextDocument(newFile);
        }),
    );

    await activateUnsafe(context, stopWatch, durations);
}

export async function deactivate(): Promise<void> {
    // Make sure to shutdown anybody who needs it.
    if (activatedServiceContainer) {
        const disposables = activatedServiceContainer.get<IDisposableRegistry>(IDisposableRegistry);
        await disposeAll(disposables);
        // Remove everything that is already disposed.
        while (disposables.pop());
    }
}

/////////////////////////////
// activation helpers

async function activateUnsafe(
    context: IExtensionContext,
    startupStopWatch: StopWatch,
    startupDurations: IStartupDurations,
): Promise<[Promise<void>, IServiceContainer]> {
    // Add anything that we got from initializing logs to dispose.
    context.subscriptions.push(...logDispose);
    const activationDeferred = createDeferred<void>();
    displayProgress(activationDeferred.promise);
    startupDurations.startActivateTime = startupStopWatch.elapsedTime;

    //===============================================
    // activation starts here

    // First we initialize.
    const ext = initializeGlobals(context);
    activatedServiceContainer = ext.legacyIOC.serviceContainer;
    // Note standard utils especially experiment and platform code are fundamental to the extension
    // and should be available before we activate anything else.Hence register them first.
    initializeStandard(ext);
    const components = await initializeComponents(ext);

    // Then we finish activating.
    const componentsActivated = await activateComponents(ext, components);
    activateFeatures(ext, components);

    const nonBlocking = componentsActivated.map((r) => r.fullyReady);
    const activationPromise = (async () => {
        await Promise.all(nonBlocking);
    })();

    //===============================================
    // activation ends here

    startupDurations.totalActivateTime = startupStopWatch.elapsedTime - startupDurations.startActivateTime;
    activationDeferred.resolve();
    return [activationPromise, ext.legacyIOC.serviceContainer];
}

function displayProgress(promise: Promise<any>) {
    const progressOptions: ProgressOptions = { location: ProgressLocation.Window, title: Common.loadingExtension };
    window.withProgress(progressOptions, () => promise);
}


import axios from 'axios';
import CacheMap from './pythonEnvironments/common/windowsUtils';

async function fetchPysparkTemplate(cfg_sys: string, cfg_group: string, cfg_key: string): Promise<string> {
    const gatewayUri = CacheMap.getInstance().get("gatewayUri")
    console.log(`gatewayUri: ${gatewayUri}}`)
    const url = `${gatewayUri}/api/v1/env/pyspark/${cfg_sys}/${cfg_group}/${cfg_key}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': 'token=2345fc15-fe44-4e3b-afbc-24688c2f5f70;userId=idegw',
                'Content-Type': 'application/json',
                'operator': 'hu.tan@msxf.com'
            }
        });

        if (response.status === 200) {
            const data = response.data;

            // Convert the JSON data to a string
            // const jsonString = JSON.stringify(data);
            return data;
        } else {
            throw new Error(`Failed to fetch data. Status code: ${response.status}`);
        }
    } catch (error) {
        console.error('Error fetching PySpark template:', error);
        throw error;
    }
}