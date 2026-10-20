// Pin-checked model boundary patch: carry already-durable task identity to the
// explicit runner provider. Hooks swallow failures and cannot enforce dispatch.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../node_modules/@earendil-works/pi-durable/', import.meta.url);
if (JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version !== '1.3.0') throw Error('Review runner identity patch before upgrading Pi');
const path = new URL('dist/harness/generation.js', root);
const original = `            const options = {
                ...streamOptions,
                signal: runtime.signal,
                sessionId: await ensureProviderSessionId(runtime, context),`;
const patched = `            const options = {
                ...streamOptions,
                // App boundary: task ID is persisted before request and reused on recovery/retry.
                ...(ref.provider === "model-runner-siwc" ? { headers: {
                    "x-pi-generation-task": String(runtime.taskId),
                    "x-pi-conversation": String(conversationId),
                } } : {}),
                signal: runtime.signal,
                sessionId: await ensureProviderSessionId(runtime, context),`;
const source = await readFile(path, 'utf8');
if (source.includes(patched)) console.log('Pi runner identity patch already applied');
else {
 if (source.split(original).length !== 2) throw Error('Unexpected Pi generation source; identity patch not applied');
 await writeFile(path, source.replace(original, patched));
 console.log('Applied Pi 1.3.0 durable runner identity patch');
}
// Compaction has its own durable task/checkpoint and needs the same no-replay boundary.
const compactPath = new URL('dist/harness/compaction.js', root);
const compactOriginal = `            const options = {
                ...forwarded,
                cacheRetention: "none",`;
const compactPatched = `            const options = {
                ...forwarded,
                ...(ref.provider === "model-runner-siwc" ? { headers: {
                    "x-pi-generation-task": String(runtime.taskId),
                    "x-pi-conversation": String(runtime.conversationId),
                    "x-pi-task-kind": "compaction",
                } } : {}),
                cacheRetention: "none",`;
const compactSource = await readFile(compactPath, 'utf8');
if (compactSource.includes(compactPatched)) console.log('Pi compaction identity patch already applied');
else {
 if (compactSource.split(compactOriginal).length !== 2) throw Error('Unexpected Pi compaction source; identity patch not applied');
 await writeFile(compactPath, compactSource.replace(compactOriginal, compactPatched));
 console.log('Applied Pi 1.3.0 compaction identity patch');
}
