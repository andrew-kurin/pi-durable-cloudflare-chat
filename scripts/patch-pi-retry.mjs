// Reproducible compatibility fix for the pinned Pi retry classifier.
// Keep original errors intact; classify captured HTTP responses before body text.
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../node_modules/@earendil-works/pi-ai/',import.meta.url);
const metadata=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
if(metadata.version!=='1.1.0')throw Error('Review status-aware retry patch before changing Pi version');
const file=new URL('dist/utils/retry.js',root);
const original="export function isRetryableAssistantError(message) {\n    if (message.stopReason !== \"error\" || !message.errorMessage)\n        return false;\n    const errorMessage = message.errorMessage;\n    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);\n}";
const patched="export function isRetryableAssistantError(message) {\n    if (message.stopReason !== \"error\" || !message.errorMessage)\n        return false;\n    const errorMessage = message.errorMessage;\n    // App patch: prefer the latest captured HTTP response to incidental body text.\n    const response = message.diagnostics?.findLast((diagnostic) =>\n        diagnostic.type === \"provider_http_response\" &&\n        Number.isInteger(diagnostic.details?.status) &&\n        diagnostic.details.status >= 100 && diagnostic.details.status <= 599);\n    const status = response?.details?.status;\n    if (status >= 400 && ![408, 429, 500, 502, 503, 504, 520, 524].includes(status))\n        return false;\n    if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage))\n        return false;\n    if (status >= 400)\n        return true;\n    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);\n}";
const source=await readFile(file,'utf8');
if(source.includes(patched)){console.log('Pi status-aware retry patch already applied');}
else{
 if(source.split(original).length!==2)throw Error('Unexpected Pi retry source; patch not applied');
 await writeFile(file,source.replace(original,patched));
 console.log('Applied Pi 1.1.0 status-aware retry patch');
}
