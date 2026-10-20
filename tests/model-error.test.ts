import {test} from 'node:test';import assert from 'node:assert/strict';import {modelErrorDiagnostic,modelErrorInfo} from '../src/model-error';
test('saved errors expose only fixed categories and allowlisted status/code, never raw payloads',()=>{
 const cases=[['Model access unavailable or daily request limit reached.','local model access guard'],['401: {"code":"invalid_api_key","message":"PRIVATE_TOKEN"}','authentication or subscription credentials'],['429: private prompt','rate or usage limit'],['400: No tool output found for function call call_id PRIVATE','tool response protocol'],['Invalid Codex SSE JSON: private body','response stream protocol'],['Codex SSE response headers timed out after 120000ms PRIVATE','request timeout'],['fetch failed PRIVATE','network transport'],['503: PRIVATE','upstream service error'],['{"code":"context_length_exceeded","message":"PRIVATE"}','context limit'],['400: PRIVATE','request rejected'],['403: PRIVATE','access denied'],['Unrecognized PRIVATE_TOKEN raw output','unclassified saved model error']];
 for(const [raw,expected] of cases){const result=modelErrorDiagnostic(raw);assert.ok(result.includes(expected),result);assert.ok(!result.includes('PRIVATE'));assert.ok(!result.includes('120000'));}
 assert.match(modelErrorDiagnostic('401: {"code":"invalid_api_key"}'),/Reported HTTP 401.*Reported code: invalid_api_key/);
 for(const raw of [null,undefined,{},'x'.repeat(65537),'token=ghp_PRIVATE https://private.example/?secret=PRIVATE','{"code":"PRIVATE_CODE"}','499: PRIVATE'])assert.equal(modelErrorDiagnostic(raw),'Diagnostic hint: unclassified saved model error.');
});

test('runner browser-integrity errors retain the actionable gateway status and code',()=>{assert.deepEqual(modelErrorInfo('Model round failed (runner gateway browser integrity blocked); automatic replay disabled.'),{category:'runner gateway browser integrity check',httpStatus:'403',code:'cloudflare_1010'});});

test('local runner limits are not mislabeled as HTTP or network failures',()=>{assert.deepEqual(modelErrorInfo('Model round failed (runner input limit); automatic replay disabled.'),{category:'runner input size limit',code:'runner_input_limit'});assert.deepEqual(modelErrorInfo('Model round failed (unsupported siwc request); automatic replay disabled.'),{category:'runner request protocol',code:'unsupported_siwc_request'});});

test('saved runner diagnostics take precedence over prose and strip unknown metadata',()=>{
 const diagnostic=(details:any)=>[{type:'model_runner_round_failure',timestamp:1,details}];
 assert.deepEqual(modelErrorInfo('PRIVATE',{not:'an array'}),{category:'unclassified saved model error'});
 assert.deepEqual(modelErrorInfo('PRIVATE',diagnostic({code:'runner_http_rejected',httpStatus:502,roundId:'PRIVATE-ID',message:'PRIVATE'})),{category:'runner HTTP rejection',code:'runner_http_rejected',httpStatus:'502'});
 assert.deepEqual(modelErrorInfo('PRIVATE',diagnostic({code:'runner_gateway_browser_integrity_blocked',httpStatus:403})),{category:'runner gateway browser integrity check',httpStatus:'403',code:'cloudflare_1010'});
 assert.deepEqual(modelErrorInfo('PRIVATE',diagnostic({code:'siwc_provider_rejected',httpStatus:502,provider:{httpStatus:400,code:'PRIVATE-CODE',param:'input[PRIVATE]',message:'PRIVATE'}})),{category:'provider request rejected',code:'siwc_provider_rejected',httpStatus:'502',providerHttpStatus:'400'});
 for(const details of [{code:'PRIVATE-CODE',httpStatus:502},{code:[],provider:{message:'PRIVATE'}},{code:'siwc_provider_rejected',httpStatus:'PRIVATE',provider:{httpStatus:201,code:'subscription_sharing_unsupported_capability',param:'input'}}]){
  const info=modelErrorInfo('PRIVATE',diagnostic(details));assert.doesNotMatch(JSON.stringify(info),/PRIVATE/);assert.equal(info.providerCode,undefined);assert.equal(info.providerHttpStatus,undefined);
 }
 const safe=diagnostic({code:'siwc_provider_rejected',httpStatus:400,provider:{httpStatus:400,code:'subscription_sharing_unsupported_capability',param:'input',message:'PRIVATE'}});
 assert.match(modelErrorDiagnostic('PRIVATE',safe),/subscription input capability rejected.*Provider HTTP 400.*subscription_sharing_unsupported_capability.*Provider parameter: input/);
 assert.doesNotMatch(modelErrorDiagnostic('PRIVATE',safe),/PRIVATE/);
 assert.deepEqual(modelErrorInfo('Model round failed (runner http rejected); automatic replay disabled.'),{category:'runner HTTP rejection',code:'runner_http_rejected'});
 assert.equal(modelErrorInfo('Model round failed (PRIVATE); automatic replay disabled.').category,'unclassified saved model error');
});
