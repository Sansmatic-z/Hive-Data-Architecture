export interface PasswordAssessment {
  score: number;
  label: 'Weak' | 'Fair' | 'Good' | 'Strong';
  warnings: string[];
}

export function assessPasswordStrength(password: string): PasswordAssessment {
  if (!password) {
    return { score: 0, label: 'Weak', warnings: [] };
  }

  let score = 0;
  const warnings: string[] = [];

  if (password.length >= 12) score += 1;
  else warnings.push('Use at least 12 characters.');

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  else warnings.push('Mix uppercase and lowercase letters.');

  if (/\d/.test(password)) score += 1;
  else warnings.push('Add digits.');

  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  else warnings.push('Add a symbol.');

  if (!/(password|123456|qwerty|letmein|admin)/i.test(password)) score += 1;
  else warnings.push('Avoid common passwords or keyboard patterns.');

  const label =
    score >= 5 ? 'Strong' : score >= 4 ? 'Good' : score >= 3 ? 'Fair' : 'Weak';

  return { score, label, warnings };
}

export function mapProtocolError(message: string): string {
  if (/ENCRYPTED_VOLUME/.test(message)) {
    return 'This archive is encrypted. Enter the password to continue.';
  }
  if (/Manifest signature verification failed/i.test(message)) {
    return 'Archive authenticity verification failed. The manifest may have been tampered with.';
  }
  if (/Unsupported HDA version/i.test(message)) {
    return 'This archive uses an unsupported protocol version for this build.';
  }
  if (/permission/i.test(message)) {
    return 'Browser file-system permission was denied. Re-grant access or switch to memory download mode.';
  }
  if (/Memory limit exceeded/i.test(message)) {
    return 'The browser blocked the current streaming mode. Open in a top-level tab or use a browser with File System Access support.';
  }
  if (/Decryption failed/i.test(message)) {
    return 'Password verification failed or the encrypted archive is corrupted.';
  }
  return message;
}

export function secureDeleteGuidance(): string {
  return 'Browser environments cannot guarantee secure deletion of temporary buffers. Prefer direct-to-disk streaming, close download tabs after use, and clear browser storage if handling sensitive material.';
}
