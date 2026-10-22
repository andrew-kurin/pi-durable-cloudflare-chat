const FILE_ERRORS = {
 file_not_found: ['Project file was not found.', 'Check the relative project path and parent directory before making a new call.'],
 file_too_large: ['Project file exceeds the 64,000-byte file-operation limit.', 'Use a bounded workspace_exec read for this file; do not repeat the same full-file operation.'],
 edit_too_large: ['The edited file would exceed the 64,000-byte file-operation limit.', 'Make a smaller edit or use an explicitly bounded workspace_exec operation for the larger file.'],
 edit_match_count: ['Edit requires exactly one occurrence of oldText.', 'Read the current file and supply unique surrounding context in oldText before making a new edit call.'],
 target_exists: ['New-file target already exists.', 'Read the existing file and use a nonempty, unique oldText to edit it; choose a different path to create a new file.'],
 not_text: ['Project target is not a regular UTF-8 text file.', 'Choose a regular UTF-8 project file; inspect other formats with an appropriate bounded workspace_exec command.'],
 permission_denied: ['Project file operation was denied by filesystem permissions.', 'Inspect the project file permissions and report the restriction before choosing another operation.'],
 path_outside_project: ['Project file path resolves outside the project.', 'Use a relative path whose resolved target remains inside the configured project.'],
 file_operation_failed: ['Project file operation failed.', 'Inspect the current project file with a bounded read before deciding on a new operation; unexpected helper details were withheld.'],
} as const;
export type WorkspaceFileErrorCode = keyof typeof FILE_ERRORS;

/** Only these fixed messages cross from the file helper into model-visible diagnostics. */
export class WorkspaceFileError extends Error {
 readonly code: WorkspaceFileErrorCode;
 readonly nextStep: string;
 constructor(code:WorkspaceFileErrorCode) {
  super(FILE_ERRORS[code][0]);
  this.name='WorkspaceFileError';this.code=code;this.nextStep=FILE_ERRORS[code][1];
 }
}
export function workspaceFileError(stderr:string):WorkspaceFileError|undefined {
 try {
  const value=JSON.parse(stderr);
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.workspaceFileError==='string'&&Object.hasOwn(FILE_ERRORS,value.workspaceFileError))return new WorkspaceFileError(value.workspaceFileError as WorkspaceFileErrorCode);
 }catch{}
 return undefined;
}
