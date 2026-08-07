import { readFileSync } from 'node:fs';
const b = readFileSync(new URL('../src/assets/flavor.png', import.meta.url));
const sig = b.slice(0, 8).toString('hex');
console.log('sig:', sig);
console.log('w,h:', b.readUInt32BE(16), b.readUInt32BE(20));
console.log('valid PNG:', sig === '89504e470d0a1a0a');
