import { runBackup, listBackups, backupStatus } from './backup.js';

const result = runBackup('manual');
console.log(`Backup written: ${result.path}`);
console.log(`  ${(result.bytes / 1_048_576).toFixed(2)} MB`);
const status = backupStatus();
console.log(`  ${status.count} backups on disk, ${(status.total_bytes / 1_048_576).toFixed(1)} MB total`);
for (const f of listBackups().slice(0, 5)) {
  console.log(`    ${f.file}  ${(f.bytes / 1_048_576).toFixed(1)} MB  ${f.at.slice(0, 16).replace('T', ' ')}`);
}
