import {test} from 'node:test';import assert from 'node:assert/strict';
import {resultSummary,safeMetadata} from '../src/tool-activity';import {conversationTitle} from '../src/conversation-title';
const result=(data:unknown,name='web_search')=>resultSummary({model:[{role:'toolResult',toolCallId:'one',toolName:name,isError:false,content:[{type:'text',text:JSON.stringify({data})}]}]} as never,name)!;
test('only selected recorded public metadata becomes bounded source evidence',()=>{
 const view=result({results:[{title:'Durable conversations',url:'https://example.com/guide?utm_source=test',excerpt:'PRIVATE RAW EXCERPT'},{title:'Another guide',url:'https://docs.example.com/guide'}]});
 assert.match(view.summary!,/2 sources returned · Durable conversations/);assert.deepEqual(view.sources,[{title:'Durable conversations',url:'https://example.com/guide'},{title:'Another guide',url:'https://docs.example.com/guide'}]);assert.ok(!JSON.stringify(view).includes('PRIVATE RAW'));
 const repo=result({url:'https://github.com/example/project',description:'A public project',text:'PRIVATE FILE BODY',sha:'RAW SHA'},'github_read');assert.equal(repo.summary,'A public project');assert.equal(repo.sources!.length,1);assert.ok(!JSON.stringify(repo).includes('PRIVATE FILE'));
 const luna=result({title:'Luna private task',url:'https://example.com',description:'PRIVATE LUNA OUTPUT'},'ask_luna');assert.equal(luna.sources,undefined);assert.equal(luna.summary,undefined);
});
test('credential URLs, private hosts, secret strings, malformed and oversized metadata fail closed',()=>{
 const urls=['javascript:alert(1)','https://user:pass@example.com','https://example.com/?token=private','https://example.com/ghp_abc123','https://127.0.0.1/a','https://localhost/a','https://127-0-0-1.nip.io/a'];
 const view=result({results:urls.map(url=>({url,title:'password=secret'})),description:'Bearer private'});assert.equal(view.sources,undefined);assert.ok(!JSON.stringify(view).includes('secret'));
 for(const text of ['<script>attack</script>','api_key=private','sk-abcdef','Bearer private','title\nsecond','https://example.com/?token=private'])assert.equal(safeMetadata(text),'');
 assert.equal(safeMetadata('x'.repeat(300)).length,140);
 for(const text of ['not JSON','x'.repeat(17000)]){const row=resultSummary({model:[{role:'toolResult',toolCallId:'c',toolName:'web_search',content:[{type:'text',text}]}]} as never,'web_search')!;assert.equal(row.sources,undefined);assert.equal(row.summary,undefined);}
});
test('conversation titles are deterministic visible-text excerpts without URLs or secret patterns',()=>{
 assert.equal(conversationTitle('  ## Compare **public tools**\nHTTPS://example.com  '),'Compare public tools');assert.equal(conversationTitle('x'.repeat(100)).length,54);for(const text of ['token=private','ghp_ABC123','github_pat_ABC123','api_key=private'])assert.equal(conversationTitle(text),'');assert.equal(conversationTitle(undefined),'');
});
