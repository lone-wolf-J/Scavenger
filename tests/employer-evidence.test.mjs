import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectUrlEvidence, enrichDecision } from '../lib/employer-evidence.mjs';
import { loadQueue, summarize } from '../review-queue.mjs';

describe('employer-evidence', () => {
  it('extracts ATS, employer-domain, and LinkedIn evidence from posting URLs', () => {
    const { evidence, careerUrl, ats, linkedin } = collectUrlEvidence([
      { url: 'https://www.dice.com/job-detail/abc', applyUrl: 'https://jobs.ashbyhq.com/acme/123' },
      { url: 'https://acme.com/careers/senior-hr-manager' },
      { url: 'https://www.linkedin.com/company/acme' },
    ]);
    assert.ok(ats.includes('Ashby'));
    assert.ok(evidence.some((e) => e.startsWith('ATS-hosted')));
    assert.ok(careerUrl.includes('acme.com/careers'));
    assert.equal(linkedin, true);
  });
  it('ignores board hosts as evidence', () => {
    const { evidence, careerUrl } = collectUrlEvidence([{ url: 'https://www.indeed.com/rc/clk?jk=1' }]);
    assert.deepEqual(evidence, []);
    assert.equal(careerUrl, '');
  });
  it('promotes medium to high only with real evidence, thresholds fixed', () => {
    const base = {
      key: 'acme', name: 'Acme', confidence: 0.7, tier: 'medium',
      evidence: ['company field present'], sources: ['dice'],
      jobCount: 2, exampleJobUrl: 'https://www.dice.com/job-detail/1', exampleLocation: 'Austin, TX',
    };
    const noProof = enrichDecision(base, [{ url: 'https://www.dice.com/job-detail/1' }]);
    assert.equal(noProof.tier, 'medium'); // board URLs add nothing
    const proof = enrichDecision(base, [
      { url: 'https://www.dice.com/job-detail/1', applyUrl: 'https://jobs.lever.co/acme/abc' },
      { url: 'https://acme.com/careers/x' },
    ]);
    assert.equal(proof.tier, 'high');
    assert.equal(proof.promoted, true);
    assert.ok(proof.potentialCompanyUrl.includes('acme.com'));
  });
  it('never promotes staffing or demotes thresholds (cap +0.15)', () => {
    const weak = {
      key: 'x', name: 'X Staffing', confidence: 0.35, tier: 'low',
      evidence: ['staffing intermediary signal'], sources: ['dice'],
      jobCount: 1, exampleJobUrl: '', exampleLocation: '',
    };
    const r = enrichDecision(weak, [{ url: 'https://acme.com/careers/y', applyUrl: 'https://jobs.ashbyhq.com/z/1' }]);
    assert.ok(r.confidence <= 0.5, `capped jump: ${r.confidence}`);
  });
});

describe('review-queue', () => {
  it('presents pending companies human-readably', () => {
    const q = [{
      key: 'acme', name: 'Acme', company: 'Acme', confidence: 0.7, tier: 'medium',
      sources: ['dice'], jobCount: 3, jobsFound: 3, relevantJobTitles: ['HR Director'],
      whyDiscovered: 'Employer "Acme" appeared on dice across 3 posting(s)',
      whyNotAutoAdded: 'Below 0.8 auto-add threshold (0.7): no ATS-hosted posting observed',
      potentialCompanyUrl: 'https://acme.com/careers',
      evidence: ['company field present'], status: 'pending',
    }];
    const text = summarize(q);
    assert.ok(text.includes('Acme (confidence 0.7'));
    assert.ok(text.includes('Why discovered:'));
    assert.ok(text.includes('Why not auto-added:'));
    assert.ok(text.includes('Potential company URL: https://acme.com/careers'));
    assert.ok(text.includes('HR Director'));
    assert.deepEqual(loadQueue('/nonexistent/path.json'), []);
  });
});
