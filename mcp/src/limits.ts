export const LIMITS = {
  maxFilesPerRead: 20,
  maxOperationsPerTransaction: 20,
  maxReadResponseBytes: 1024 * 1024, // 1 MiB max total response budget
  maxFileWriteBytes: 2 * 1024 * 1024, // 2 MiB max per file write
  maxTotalWriteBytes: 2 * 1024 * 1024, // 2 MiB max per transaction write
  maxSearchQueryBytes: 512,
  maxSearchResults: 200,
} as const;
