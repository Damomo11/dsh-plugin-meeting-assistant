import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { buildCoachInput } = await import('../../lite/coach-prompt.mjs');
const brief = { invitation: '我的世界椰汁橙小镇会议', goal: '椰汁橙应该建10台刷沙机', role: '小镇成员Damomo1', initialViews: '椰汁橙应该建更多的刷沙机', cwd: '', filePaths: [], files: [] };
const entries = [{ line: 1, ts: Date.now(), text: '今天讨论一下我们小镇的刷沙机建设，大家发表意见' }];
const input = buildCoachInput(brief, entries, undefined, 0, undefined);
console.log('system 字数:', input.system.length);
console.log('prompt 字数:', input.prompt.length);
console.log('evidence 条数:', input.evidence.length);
