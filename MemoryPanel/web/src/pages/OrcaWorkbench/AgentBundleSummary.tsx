/** Browser wire types mirror the optional package fields returned by Workbench. */
export type AgentBundleSelection = {
  schema: 1;
  skills: { skillId: string; version: number; slug: string }[];
  wikiReferences?: { kind: 'wiki_page'; wikiId: string; ref: string }[];
  memory?: { assetId: string };
};
export type HandoffAgentProfile = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  updatedAt: string;
  bundle?: AgentBundleSelection;
};
export type AgentBundleSnapshot = {
  schema: 'tencent.agent-bundle.v1';
  digest: string;
  files: { path: string; content: string; sha256: string; executable: boolean }[];
};

export function AgentBundlePreview({ bundle }: { bundle?: AgentBundleSelection }) {
  if (!bundle) return null;
  const wikiCount = new Set(
    (bundle.wikiReferences || []).map((reference) => `${reference.wikiId}\0${reference.ref}`),
  ).size;
  return (
    <details>
      <summary>Skill package included</summary>
      <ul>
        {bundle.skills.map((skill) => (
          <li key={skill.skillId}>
            {skill.slug} · pinned version {skill.version}
          </li>
        ))}
      </ul>
      <p>
        {wikiCount} Agent-linked Wiki {wikiCount === 1 ? 'page' : 'pages'}
        {bundle.memory ? ' · Agent memory snapshot, read-only' : ' · No Agent memory selected'}.
        Task and project context are included separately.
      </p>
      <small>
        Required files and access are checked before launch. This package does not add tool
        connections or grant memory writes.
      </small>
    </details>
  );
}

type ManifestSkill = {
  name?: string;
  slug?: string;
  skillId?: string;
  version?: number;
  source?: unknown;
};
type ManifestSummary = {
  skills: ManifestSkill[];
  wikiCount: number;
  memory: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function manifestSummary(bundle: AgentBundleSnapshot): ManifestSummary | undefined {
  const file = bundle.files.find((item) => item.path === 'manifest.json');
  if (!file) return;
  try {
    const manifest = record(JSON.parse(file.content));
    if (!manifest || !Array.isArray(manifest.skills)) return;
    return {
      skills: manifest.skills.filter((skill): skill is ManifestSkill => !!record(skill)),
      wikiCount: Array.isArray(manifest.wiki) ? manifest.wiki.length : 0,
      memory: record(manifest.memory)?.enabled === true,
    };
  } catch {
    return;
  }
}

function sourceLabel(source: unknown) {
  const value = record(source);
  if (!value) return '';
  // Pilot provenance nests upstream metadata; other native Skills may store it directly.
  const upstream = record(value.upstream) || value;
  const version = upstream.skillVersion;
  const revision = upstream.commit || upstream.revision;
  const repository = upstream.repository;
  return [
    typeof repository === 'string' ? repository : '',
    typeof version === 'string' ? `upstream ${version}` : '',
    typeof revision === 'string' ? `commit ${revision.slice(0, 12)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function AgentBundleReceipt({
  bundle,
  sent = false,
}: {
  bundle?: AgentBundleSnapshot;
  sent?: boolean;
}) {
  if (!bundle) return null;
  const manifest = manifestSummary(bundle);
  return (
    <details className="handoff-receipt">
      <summary>{sent ? 'Agent package sent' : 'Saved Agent package'}</summary>
      <p>
        {bundle.files.length} files · package{' '}
        <code title={bundle.digest}>{bundle.digest.slice(0, 12)}</code>
      </p>
      {manifest ? (
        <>
          <ul>
            {manifest.skills.map((skill, index) => (
              <li key={skill.skillId || index}>
                {typeof skill.name === 'string'
                  ? skill.name
                  : typeof skill.slug === 'string'
                    ? skill.slug
                    : 'Skill'}
                {typeof skill.version === 'number' ? ` · pinned version ${skill.version}` : ''}
                {sourceLabel(skill.source) && (
                  <p>
                    <small>{sourceLabel(skill.source)}</small>
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p>
            {manifest.wikiCount} Wiki {manifest.wikiCount === 1 ? 'page' : 'pages'}
            {manifest.memory
              ? ' · Agent memory snapshot, read-only'
              : ' · No Agent memory selected'}
            .
          </p>
        </>
      ) : (
        <p>Package manifest summary is unavailable. The saved file list is shown below.</p>
      )}
      <details>
        <summary>Package files</summary>
        <ul>
          {bundle.files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code>
              {file.executable ? ' · executable script' : ''}
            </li>
          ))}
        </ul>
      </details>
      <small>Saved at launch. Editing the Agent does not change this handoff.</small>
    </details>
  );
}
