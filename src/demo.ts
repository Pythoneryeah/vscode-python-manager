import * as crypto from 'crypto';

function getMd5Hash(value: string): string {
    return crypto.createHash('md5').update(value).digest('hex');
}

function preprocessAndHashDependencies(value: string): string {
    // 将输入字符串按行分割
    const lines = value.split('\n');

    // 找到 `dependencies:` 的起始行
    const dependenciesStartIndex = lines.findIndex(line => line.trim() === 'dependencies:');

    // 找到 `dependencies:` 之后的 `prefix:` 行，表示 dependencies 结束
    const prefixStartIndex = lines.findIndex(line => line.trim().startsWith('prefix:'));

    // 提取 dependencies 部分的内容（跳过 `dependencies:` 行）
    const dependencies = lines.slice(dependenciesStartIndex + 1, prefixStartIndex).map(line => line.trim());

    // 去除空行
    const filteredDependencies = dependencies.filter(line => line !== '');

    // 对 dependencies 内容进行排序
    const sortedDependencies = filteredDependencies.sort();

    // 将排序后的 dependencies 内容组合成一个字符串
    const processedDependencies = sortedDependencies.join('\n');

    // 生成并返回 MD5 哈希
    return getMd5Hash(processedDependencies);
}

// 示例值
const envValue = `
name: myenv
channels:
  - defaults
dependencies:
  - _libgcc_mutex=0.1=main
  - _openmp_mutex=5.1=1_gnu
  - ca-certificates=2024.7.2=h06a4308_0
  - ld_impl_linux-64=2.38=h1181459_1
  - libffi=3.4.4=h6a678d5_1
  - libgcc-ng=11.2.0=h1234567_1
  - libgomp=11.2.0=h1234567_1
  - libstdcxx-ng=11.2.0=h1234567_1
  - ncurses=6.4=h6a678d5_0
  - openssl=3.0.14=h5eee18b_0
  - pip=24.2=py38h06a4308_0
  - python=3.8.19=h955ad1f_0
  - readline=8.2=h5eee18b_0
  - setuptools=72.1.0=py38h06a4308_0
  - sqlite=3.45.3=h5eee18b_0
  - tk=8.6.14=h39e8969_0
  - wheel=0.43.0=py38h06a4308_0
  - xz=5.4.6=h5eee18b_1
  - zlib=1.2.13=h5eee18b_1
prefix: /root/anaconda3/envs/myenv
`;

// 示例值
const envValue123 = `
name: myenv123
channels:
  - defaults
dependencies:
  - _libgcc_mutex=0.1=main
  - _openmp_mutex=5.1=1_gnu
  - ca-certificates=2024.7.2=h06a4308_0
  - ld_impl_linux-64=2.38=h1181459_1
  - libffi=3.4.4=h6a678d5_1
  - libgcc-ng=11.2.0=h1234567_1
  - libgomp=11.2.0=h1234567_1
  - libstdcxx-ng=11.2.0=h1234567_1
  - ncurses=6.4=h6a678d5_0
  - openssl=3.0.14=h5eee18b_0
  - pip=24.2=py38h06a4308_0
  - python=3.8.19=h955ad1f_0
  - readline=8.2=h5eee18b_0
  - setuptools=72.1.0=py38h06a4308_0
  - sqlite=3.45.3=h5eee18b_0
  - tk=8.6.14=h39e8969_0
  - wheel=0.43.0=py38h06a4308_0
  - xz=5.4.6=h5eee18b_1
  - zlib=1.2.13=h5eee18b_1
prefix: /root/anaconda3/envs/myenv123
`;

// 计算 MD5 哈希
const md5Hash = preprocessAndHashDependencies(envValue);
console.log(`MD5 Hash: ${md5Hash}`);

const md5Hash123 = preprocessAndHashDependencies(envValue123);
console.log(`MD5 Hash: ${md5Hash123}`);
