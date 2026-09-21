#!/usr/bin/env node
// npm bin 入口：真正的实现编译在 dist/ 里，这里只做一个转发，
// 保证 `resume-cli` 这个命令名在全球安装（npm i -g）和本地 npm link 下都一致。
import '../dist/cli.js';
