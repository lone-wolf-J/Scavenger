// Profile service — wraps workspace functions for profile access

import { listProfiles, type ScavengerProfile } from './workspace';

export async function getProfile(profileId: string): Promise<ScavengerProfile | null> {
  const profiles = await listProfiles();
  return profiles.find((p) => p.id === profileId) || null;
}

export async function listAllProfiles(): Promise<ScavengerProfile[]> {
  return listProfiles();
}

export type { ScavengerProfile };
