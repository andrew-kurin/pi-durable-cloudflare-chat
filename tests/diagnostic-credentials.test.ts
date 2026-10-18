import {test} from 'node:test';import assert from 'node:assert/strict';import {redactDiagnosticCredentials} from '../src/diagnostic-credentials';
test('credential-only redaction preserves HTML, error codes, contact details, URLs and correlation IDs',()=>{
 const token='opaque-CREDENTIAL-value',refresh='refresh/CREDENTIAL+value';const raw='<html><h1>403 Unable to load site</h1> owner@example.test https://example.test/help?case=403 cf-ray=a4a13acd98a8f9ce-LAX code=model_access_denied '+token+' '+encodeURIComponent(refresh)+' Authorization: Bearer abc.def.ghi</html>';
 const result=redactDiagnosticCredentials(raw,[token,refresh]);for(const text of ['<html>','Unable to load site','owner@example.test','https://example.test/help?case=403','a4a13acd98a8f9ce-LAX','model_access_denied'])assert.ok(result.includes(text));for(const text of [token,encodeURIComponent(refresh),'abc.def.ghi'])assert.ok(!result.includes(text));
 assert.ok(!redactDiagnosticCredentials('prefix '+token.slice(0,15),[token]).includes(token.slice(0,15)));
});

test('encoded credentials accept mixed-case escapes while literal credential case remains significant',()=>{
 const secret='refresh/secret+value=';
 for(const encoded of ['refresh%2fsecret%2bvalue%3d','refresh%2Fsecret%2bvalue%3D']){
  assert.equal(redactDiagnosticCredentials(encoded,[secret]),'[credential redacted]');
  assert.equal(redactDiagnosticCredentials('prefix '+encoded.slice(0,-3),[secret]),'prefix [partial credential redacted]');
 }
 assert.equal(redactDiagnosticCredentials('REFRESH%2fsecret%2bvalue%3d',[secret]),'REFRESH%2fsecret%2bvalue%3d');
});
