// src/server/types.ts
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Mode = 'personal' | 'company';
export type UserStatus = 'invited' | 'active' | 'offboarding' | 'disabled';
export type SourceKind = 'private' | 'company';
export type ClientPurpose = 'agent' | 'ui' | 'instance' | 'company_writer';

export type User = { id: string; email: string; name: string | null; role: Role; status: UserStatus; createdAt: Date };
export type Source = { id: string; kind: SourceKind; ownerUserId: string | null; name: string; status: 'active' | 'archived' };
export type Grant = { userId: string; sourceId: string; agentReads: boolean };

export type ClientSpec = {
  purpose: ClientPurpose;
  userId: string | null;
  name: string;            // gbrain client name, deterministic (compile.ts clientName)
  profile: string;         // gbrain grant profile
  writeSource: string;     // gbrain source id
  readSources: string[];   // federated read, sorted, excludes writeSource
};

export type IssuedClient = { clientId: string; token: string; expiresAt: Date | null };
