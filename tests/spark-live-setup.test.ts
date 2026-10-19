import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Spark live setup: protected synthetic import, exclusive writes, inert plans and credential-free boot units',()=>{
 const r=spawnSync('python3',['-B','ops/spark-live/test_setup.py'],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 12 tests/);
});
