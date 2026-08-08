import { Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return argon2Hash(password, PASSWORD_HASH_OPTIONS);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return argon2Verify(passwordHash, password);
  }
}
