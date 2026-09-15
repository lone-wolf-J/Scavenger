import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCompanyIdentity, isBoardAsEmployer, isStaffingIntermediary, isGenericEmployerName,
} from '../lib/company-normalize.mjs';
import { classifyUsLocation, isUsLocation } from '../lib/us-location.mjs';
import { normalizeJob } from '../lib/job-model.mjs';

describe('company-normalize', () => {
  it('strips legal suffixes and case', () => {
    assert.equal(normalizeCompanyIdentity('Acme Inc.'), 'acme');
    assert.equal(normalizeCompanyIdentity('ACME, LLC'), 'acme');
    assert.equal(normalizeCompanyIdentity('Acme Corporation'), 'acme');
    assert.equal(normalizeCompanyIdentity('Acme Inc.'), normalizeCompanyIdentity('acme'));
  });
  it('unifies technology/technologies and abbreviations', () => {
    assert.equal(normalizeCompanyIdentity('Acme Technologies'), normalizeCompanyIdentity('Acme Technology'));
    assert.equal(normalizeCompanyIdentity('IBM'), normalizeCompanyIdentity('International Business Machines'));
  });
  it('handles punctuation and parentheticals', () => {
    assert.equal(normalizeCompanyIdentity('Acme Co.'), 'acme');
    assert.equal(normalizeCompanyIdentity('Acme (formerly Beta)'), 'acme');
  });
  it('returns empty for non-string/empty', () => {
    assert.equal(normalizeCompanyIdentity(''), '');
    assert.equal(normalizeCompanyIdentity(null), '');
  });
  it('rejects boards as employers', () => {
    assert.equal(isBoardAsEmployer('Dice'), true);
    assert.equal(isBoardAsEmployer('Dice Employer'), true);
    assert.equal(isBoardAsEmployer('LinkedIn Jobs'), true);
    assert.equal(isBoardAsEmployer('ZipRecruiter'), true);
    assert.equal(isBoardAsEmployer('Microsoft'), false);
  });
  it('detects staffing intermediaries', () => {
    assert.equal(isStaffingIntermediary('TekSystems Staffing'), true);
    assert.equal(isStaffingIntermediary('Randstad USA'), true);
    assert.equal(isStaffingIntermediary('Microsoft'), false);
  });
  it('detects generic placeholders', () => {
    assert.equal(isGenericEmployerName('Confidential'), true);
    assert.equal(isGenericEmployerName('Stealth Startup'), true);
    assert.equal(isGenericEmployerName('Acme'), false);
  });
});

describe('us-location', () => {
  const us = ['Austin, TX', 'New York, NY', 'Seattle, Washington', 'Remote - United States', 'Remote - US', 'Remote in Texas', 'United States', 'USA', 'Boston, MA'];
  for (const loc of us) {
    it(`accepts US: ${loc}`, () => {
      assert.equal(isUsLocation(loc), true, loc);
    });
  }
  const nonUs = ['Toronto, Canada', 'London, UK', 'Bangalore, India', 'Berlin, Germany', 'Remote', 'Remote - Worldwide', 'worldwide', 'global', 'Remote - North America', 'Sydney, Australia'];
  for (const loc of nonUs) {
    it(`rejects non-US: ${loc}`, () => {
      assert.equal(isUsLocation(loc), false, loc);
    });
  }
  it('does not mistake Indiana for India-adjacent words', () => {
    assert.equal(isUsLocation('Indianapolis, IN'), true);
    assert.equal(isUsLocation('Indian Head, MD'), true);
  });
  it('unknown locations are rejected in strict mode', () => {
    assert.equal(classifyUsLocation('').verdict, 'unknown');
    assert.equal(isUsLocation(''), false);
  });
});

describe('job-model', () => {
  it('normalizes a minimal provider job', () => {
    const j = normalizeJob({ title: 'AI Engineer', url: 'https://x.com/j/1', company: 'Acme', location: 'Austin, TX' }, 'dice', 123);
    assert.equal(j.title, 'AI Engineer');
    assert.equal(j.source, 'dice');
    assert.equal(j.state, 'TX');
    assert.equal(j.city, 'Austin');
    assert.equal(j.country, 'US');
    assert.equal(j.discoveredAt, 123);
    assert.ok(j.id.startsWith('dice:'));
  });
  it('parses workplace and employment types', () => {
    const j = normalizeJob({ title: 'Contract Backend Engineer', location: 'Remote - US' }, 'indeed');
    assert.equal(j.workplaceType, 'remote');
    assert.equal(j.employmentType, 'contract');
  });
  it('extracts LinkedIn job ids and preserves extras', () => {
    const j = normalizeJob({ title: 'T', url: 'https://www.linkedin.com/jobs/view/12345?x=1', foo: 'bar' }, 'linkedin');
    assert.equal(j.sourceJobId, '12345');
    assert.equal(j.rawProviderData.foo, 'bar');
  });
});
