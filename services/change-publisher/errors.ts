export const candidateMessages={
 git_validation_failed:'The public base or patch could not be reconstructed. Inspect the export and base commit; no repository scripts were run.',
 source_base_mismatch:'The fetched public source does not match the immutable export base.',
 candidate_tree_mismatch:'The reconstructed patch does not match the exported tested tree. Create a new consistent export after checking source changes.',
 unsupported_path:'This first milestone supports src/, public/, tests/ and docs/ paths, excluding the publication bridge. Paths outside those roots, including root config/dependency files, workflows and services, require separate manual publication.',
 unsupported_file_type:'Only regular non-executable UTF-8 text files are supported; binaries, symlinks and file mode changes require manual publication.',
 candidate_too_large:'A proposal supports 1–50 changed files, at most 128,000 bytes per text file and 512,000 bytes of added/updated file content. Split the change or publish manually.',
} as const;
export class CandidateFailure extends Error {constructor(readonly code:keyof typeof candidateMessages){super(candidateMessages[code]);}}
