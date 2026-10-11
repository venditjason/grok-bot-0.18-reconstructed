import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const built = await build({entryPoints:[new URL('../frontend/venditbot/markdown.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {markdownBlocks,inlineParts}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
test('Markdown preserves code fences, tables, lists and unfinished streamed fences',()=>{
 const blocks=markdownBlocks('# Title\n\n- One\n- Two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst x = 1;');
 assert.deepEqual(blocks.map(b=>b.type),['heading','list','table','code']);
 assert.equal(blocks.at(-1).text,'const x = 1;');
 assert.deepEqual(blocks[2].rows,[['1','2']]);
});
test('Markdown never promotes HTML or URL schemes into executable elements',()=>{
 const html='<img src=x onerror=alert(1)>\n<script>alert(1)</script>';
 assert.deepEqual(markdownBlocks(html),[{type:'paragraph',text:html}]);
 const link=inlineParts('[open](javascript:evil)')[0];
 assert.deepEqual(link,{type:'link',text:'open',url:'javascript:evil'});
 assert.deepEqual(inlineParts('`<script>`'),[{type:'code',text:'<script>'}]);
});
