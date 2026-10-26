/**
 * REST gateway over the anti-doping governance chaincodes.
 *
 * Every route names the organizational class it acts as, because authorization
 * in this framework is a property of the submitting identity rather than of an
 * application-layer session: the chaincode refuses a laboratory result signed
 * by a NADO identity regardless of what the API believes.
 *
 * The gateway performs no authorization of its own. It is a protocol adapter,
 * and deliberately cannot widen what the ledger permits.
 */

import express, { Request, Response } from 'express';
import { createHash } from 'crypto';
import { OrgKey, closeAll, contractFor, decode, isOrgKey, ORGS } from './fabric';
import * as offchain from './offchain';
import { AuthError, bearer, login, logout, sessionFor } from './auth';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3000);

/**
 * The organization this request acts as.
 *
 * Always the authenticated session's organization. The previous behaviour -
 * reading `?org=` or an `x-org` header - let any caller choose which of the five
 * enrolled identities signed their transaction, which is impersonation, not
 * configuration. The parameter is still accepted so existing scripts keep
 * working, but only when it names the session's own organization.
 */
function actingOrg(req: Request, fallback: OrgKey): OrgKey {
  const session = sessionFor(bearer(req.header('authorization')));
  if (session) {
    const asked = String(req.header('x-org') ?? req.query.org ?? '').toLowerCase();
    if (asked && isOrgKey(asked) && asked !== session.org) {
      throw new AuthError(
        `signed in as ${session.org}; cannot act as ${asked}`,
        403,
      );
    }
    return session.org;
  }
  return fallback;
}

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Recover the chaincode's own rejection message.
 *
 * fabric-gateway surfaces an endorsement failure as a gRPC error whose
 * `message` is only "10 ABORTED: failed to endorse transaction"; the message
 * the contract actually raised sits in a `details` array, one entry per
 * endorsing peer. Reading `message` alone loses the regulatory reason and
 * reports every refusal as an indistinguishable 400.
 */
function chaincodeMessage(error: unknown): string {
  const details = (error as { details?: unknown })?.details;
  if (Array.isArray(details)) {
    const messages = details
      .map((d) => (d as { message?: string })?.message)
      .filter((m): m is string => Boolean(m));
    if (messages.length > 0) return messages.join('; ');
  }
  const message = error instanceof Error ? error.message : String(error);
  return /details=\[(.*?)\]/s.exec(message)?.[1] ?? message;
}

/** Surface chaincode rejections as 403/404/409 rather than an opaque 500. */
const route =
  (handler: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      const details = chaincodeMessage(error);

      if (/authorization denied|only the athlete|GDPR Article 22/i.test(details)) {
        res.status(403).json({ error: 'forbidden by chaincode policy', details });
        return;
      }
      if (/not found|does not exist/i.test(details)) {
        res.status(404).json({ error: 'not found', details });
        return;
      }
      if (/ENDORSEMENT_POLICY_FAILURE/i.test(details)) {
        res.status(409).json({
          error: 'endorsement policy not satisfied',
          details,
          hint: 'this key requires endorsement from two organizational classes',
        });
        return;
      }
      res.status(400).json({ error: 'transaction rejected', details });
    }
    // No next(): every branch above has already sent a response.
  };

interface SubmitOptions {
  /** Inputs written to the transient field rather than the shared block. */
  transient?: unknown;
  /** Organisations whose peers must endorse; required where a key or collection policy names them. */
  endorsers?: string[];
}

/**
 * Endorse, submit and wait for commit. Endorsers are named explicitly because
 * the platform's discovery plan follows the chaincode-level policy only, and a
 * write to a key bound to the NADO and the laboratory, or to a collection
 * whose policy names them, would otherwise be endorsed by the wrong pair and
 * rejected at validation.
 */
async function submit(org: OrgKey, cc: 'custody' | 'consent', fn: string, args: string[], options: SubmitOptions = {}) {
  const contract = await contractFor(org, cc);
  const proposal = contract.newProposal(fn, {
    arguments: args,
    ...(options.transient !== undefined
      ? { transientData: { input: Buffer.from(JSON.stringify(options.transient)) } }
      : {}),
    ...(options.endorsers ? { endorsingOrganizations: options.endorsers } : {}),
  });
  const transaction = await proposal.endorse();
  const submitted = await transaction.submit();
  const status = await submitted.getStatus();
  if (!status.successful) {
    const reason = status.code === 10 ? 'ENDORSEMENT_POLICY_FAILURE' : `code ${status.code}`;
    throw new Error(`transaction ${status.transactionId} failed validation: ${reason}`);
  }
  return decode(transaction.getResult());
}

/** Evaluate, optionally on a peer of a named organisation (private data lives only on member peers). */
async function evaluate(org: OrgKey, cc: 'custody' | 'consent', fn: string, args: string[], endorsers?: string[]) {
  const contract = await contractFor(org, cc);
  return decode(await contract.evaluate(fn, { arguments: args, ...(endorsers ? { endorsingOrganizations: endorsers } : {}) }));
}


// ------------------------------------------------------------------- auth

/**
 * Sign in against the organization's certification authority.
 *
 * The seeded identities are `<org>user` / `<org>userpw` (client) and
 * `<org>admin` / `<org>adminpw` (administrator), created by
 * scripts/registerEnroll.sh when the network is built.
 */
app.post(
  '/api/auth/login',
  route(async (req, res) => {
    const { org, username, password } = req.body ?? {};
    const session = await login(org, username, password);
    res.json({
      token: session.token,
      org: session.org,
      username: session.username,
      mspId: ORGS[session.org].msp,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }),
);

app.post(
  '/api/auth/logout',
  route(async (req, res) => {
    logout(bearer(req.header('authorization')) ?? '');
    res.json({ ok: true });
  }),
);

app.get(
  '/api/auth/session',
  route(async (req, res) => {
    const session = sessionFor(bearer(req.header('authorization')));
    if (!session) throw new AuthError('not signed in');
    res.json({
      org: session.org,
      username: session.username,
      mspId: ORGS[session.org].msp,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }),
);

/** Everything under /api requires a session, except signing in. */
app.use('/api', (req: Request, res: Response, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!sessionFor(bearer(req.header('authorization')))) {
    res.status(401).json({ error: 'authentication required', hint: 'POST /api/auth/login' });
    return;
  }
  return next();
});

/** Live view of the deployed network, for the platform's status panel. */
app.get(
  '/api/network',
  route(async (_req, res) => {
    const organizations = await Promise.all(
      (Object.keys(ORGS) as OrgKey[]).map(async (org) => {
        const started = Date.now();
        let reachable = false;
        try {
          await evaluate(org, 'consent', 'getDataCategories', []);
          reachable = true;
        } catch {
          reachable = false;
        }
        return {
          org,
          mspId: ORGS[org].msp,
          peer: `peer0.${org}.antidoping.org:${ORGS[org].port}`,
          reachable,
          latencyMs: Date.now() - started,
        };
      }),
    );
    res.json({
      channel: process.env.CHANNEL ?? 'antidopingchannel',
      chaincodes: ['custody', 'consent'],
      organizations,
      ipfs: await offchain.ipfsReachable(),
      orderers: ['athlete', 'federation', 'nado', 'lab'].map((o) => `orderer.${o}.antidoping.org`),
    });
  }),
);

// ------------------------------------------------------------------ meta

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', organizations: Object.keys(ORGS) });
});

app.get(
  '/api/categories',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'athlete'), 'consent', 'getDataCategories', []));
  }),
);

// --------------------------------------------------------------- custody

const NADO_LAB = ['NADOMSP', 'LabMSP'];
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

app.post(
  '/api/prohibited-list',
  route(async (req, res) => {
    const { version, hash } = req.body;
    res.json(await submit(actingOrg(req, 'nado'), 'custody', 'registerProhibitedList', [version, hash], { endorsers: NADO_LAB }));
  }),
);

/** WADA Article 5.3 — the doping control form stays off-chain; its digest is written. */
app.post(
  '/api/samples',
  route(async (req, res) => {
    const { sampleCode, athleteHash, sealedContainerHash, dopingControlForm } = req.body;
    res.status(201).json(
      await submit(
        actingOrg(req, 'nado'),
        'custody',
        'initiateSampleCustody',
        [sampleCode, athleteHash, sealedContainerHash, digest(JSON.stringify(dopingControlForm ?? {}))],
        { endorsers: NADO_LAB },
      ),
    );
  }),
);

/** The athlete's own attestation of the collection, as on the doping control form. */
app.post(
  '/api/samples/:code/acknowledge',
  route(async (req, res) => {
    res.status(201).json(
      await submit(actingOrg(req, 'athlete'), 'custody', 'acknowledgeSampleCollection', [req.params.code, req.body.sealedContainerHash], {
        endorsers: ['AthleteMSP', 'NADOMSP'],
      }),
    );
  }),
);

/** WADA Article 5.4, first half: dispatch, under the NADO's identity. */
app.post(
  '/api/samples/:code/dispatch',
  route(async (req, res) => {
    const { containerSealIntact, transferWindowHours } = req.body;
    res.status(201).json(
      await submit(
        actingOrg(req, 'nado'),
        'custody',
        'proposeCustodyTransfer',
        [req.params.code, 'LabMSP', String(containerSealIntact ?? true), String(transferWindowHours ?? 48)],
        { endorsers: NADO_LAB },
      ),
    );
  }),
);

/** WADA Article 5.4, second half: receipt, under the laboratory's identity. */
app.post(
  '/api/samples/:code/receipt',
  route(async (req, res) => {
    const { sequence, containerSealIntact, observedSealHash } = req.body;
    res.status(201).json(
      await submit(
        actingOrg(req, 'lab'),
        'custody',
        'acceptCustodyTransfer',
        [req.params.code, String(sequence ?? 1), String(containerSealIntact ?? true), observedSealHash],
        { endorsers: NADO_LAB },
      ),
    );
  }),
);

/** WADA Article 2.1 — private; the result travels in the transient field. */
app.post(
  '/api/samples/:code/analysis',
  route(async (req, res) => {
    const { adverse, substance, prohibitedListVersion, prohibitedListHash, laboratoryAccreditation } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'lab'), 'custody', 'recordSampleAnalysisResult', [req.params.code], {
        transient: {
          adverse: adverse === true || adverse === 'true',
          substance: substance ?? '',
          prohibitedListVersion,
          prohibitedListHash,
          laboratoryAccreditation: laboratoryAccreditation ?? 'VERIFIED',
        },
        endorsers: NADO_LAB,
      }),
    );
  }),
);

/** WADA Article 7.1 — runs the Table 1 decision engine; the record is then read by a member. */
app.post(
  '/api/samples/:code/results-management',
  route(async (req, res) => {
    const org = actingOrg(req, 'nado');
    await submit(org, 'custody', 'triggerResultsManagement', [req.params.code], { endorsers: NADO_LAB });
    res.json(await evaluate(org, 'custody', 'getResultsManagement', [req.params.code], [ORGS[org].msp]));
  }),
);

/** A change to a committed outcome: proposed by one organisation ... */
app.post(
  '/api/samples/:code/amendments',
  route(async (req, res) => {
    const { action, reason } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'proposeResultsAmendment', [req.params.code], {
        transient: { action, reason },
        endorsers: NADO_LAB,
      }),
    );
  }),
);

/** ... and approved by the other. */
app.post(
  '/api/samples/:code/amendments/:index/approve',
  route(async (req, res) => {
    res.json(
      await submit(actingOrg(req, 'lab'), 'custody', 'approveResultsAmendment', [req.params.code, req.params.index], {
        endorsers: NADO_LAB,
      }),
    );
  }),
);

/** WADA Article 2.4 — a failure status; the filing itself stays off-chain. */
app.post(
  '/api/whereabouts',
  route(async (req, res) => {
    const { athleteHash, filingId, failure, ledgerVerified } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'recordWhereaboutsStatus', [], {
        transient: { athleteHash, filingId, failure: failure !== false, ledgerVerified: ledgerVerified !== false },
        endorsers: NADO_LAB,
      }),
    );
  }),
);

/** Athlete Biological Passport evaluation — feeds conditions Q003 and Q004. */
app.post(
  '/api/passport-evaluation',
  route(async (req, res) => {
    const { athleteHash, anomaly, expertPanelRequired } = req.body;
    await submit(actingOrg(req, 'lab'), 'custody', 'recordPassportEvaluation', [], {
      transient: { athleteHash, anomaly: anomaly !== false, expertPanelRequired: expertPanelRequired !== false },
      endorsers: NADO_LAB,
    });
    res.status(201).json({ recorded: true });
  }),
);

/** Register an off-chain payload: CID, key reference and keyed commitment, privately. */
app.post(
  '/api/offchain-payload',
  route(async (req, res) => {
    const { athleteHash, category, cid, keyRef, commitment } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'lab'), 'consent', 'registerOffchainPayload', [], {
        transient: { athleteHash, category, cid, keyRef, commitment },
        endorsers: ['AthleteMSP'],
      }),
    );
  }),
);

/** WADA Article 7.3 */
app.post(
  '/api/samples/:code/notify',
  route(async (req, res) => {
    res.json(await submit(actingOrg(req, 'nado'), 'custody', 'notifyAthleteOfAAF', [req.params.code], { endorsers: NADO_LAB }));
  }),
);

/** GDPR Article 22 oversight record, prerequisite for Article 7.9. */
app.post(
  '/api/samples/:code/oversight',
  route(async (req, res) => {
    const { reviewerId, decision, rationale } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'enforceOversightRequirement', [req.params.code], {
        transient: { reviewerId, decision, rationale },
        endorsers: NADO_LAB,
      }),
    );
  }),
);

/** WADA Article 7.9 — refused unless an upholding oversight record exists. */
app.post(
  '/api/samples/:code/provisional-suspension',
  route(async (req, res) => {
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'recordProvisionalSuspension', [req.params.code], {
        transient: { groundsArticle: req.body.groundsArticle ?? 'Article 7.9' },
        endorsers: NADO_LAB,
      }),
    );
  }),
);

app.get(
  '/api/samples/:code',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'nado'), 'custody', 'getSample', [req.params.code]));
  }),
);

app.get(
  '/api/samples/:code/custody-chain',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'nado'), 'custody', 'getCustodyChain', [req.params.code]));
  }),
);

app.get(
  '/api/samples/:code/history',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'nado'), 'custody', 'getSampleHistory', [req.params.code]));
  }),
);

/**
 * WADA Article 14.1 — the confidentiality gate, evaluated as the caller on
 * the caller's own peer: a federation or research peer holds no results to
 * return even if asked.
 */
app.get(
  '/api/samples/:code/results',
  route(async (req, res) => {
    const org = actingOrg(req, 'nado');
    const decision = (await evaluate(org, 'custody', 'enforceResultsConfidentiality', [req.params.code], [ORGS[org].msp])) as {
      granted: boolean;
    };
    res.status(decision.granted ? 200 : 403).json(decision);
  }),
);

/** Table 1 evaluated directly, for the decision-table explorer in the UI. */
app.post(
  '/api/decision-table/evaluate',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'nado'), 'custody', 'evaluateDecisionTable', [JSON.stringify(req.body)]));
  }),
);

// --------------------------------------------------------------- consent
// Consent state lives only on athlete-organisation peers, so every consent
// transaction and read is directed there.

const ATHLETE_PEERS = ['AthleteMSP'];
const csv = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v));

/** GDPR Article 7 — only the athlete organisation may write consent. */
app.post(
  '/api/consent',
  route(async (req, res) => {
    const { athleteHash, grantedToMSP, purpose, categories, validFrom, validUntil, specialCategoryAuthorised } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'athlete'), 'consent', 'recordConsentTransaction', [], {
        transient: {
          athleteHash,
          grantedToMSP,
          purpose,
          categories: csv(categories),
          validFrom,
          validUntil,
          specialCategoryAuthorised: specialCategoryAuthorised === true,
        },
        endorsers: ATHLETE_PEERS,
      }),
    );
  }),
);

/** GDPR Article 7(3) */
app.delete(
  '/api/consent',
  route(async (req, res) => {
    const { athleteHash, grantedToMSP, purpose } = req.body;
    res.json(
      await submit(actingOrg(req, 'athlete'), 'consent', 'withdrawConsent', [], {
        transient: { athleteHash, grantedToMSP, purpose },
        endorsers: ATHLETE_PEERS,
      }),
    );
  }),
);

app.get(
  '/api/consent/:athleteHash',
  route(async (req, res) => {
    res.json(await evaluate(actingOrg(req, 'athlete'), 'consent', 'listConsents', [req.params.athleteHash], ATHLETE_PEERS));
  }),
);

/** The ABAC gate: records the decision, then reads it back for the requester. */
app.post(
  '/api/access-request',
  route(async (req, res) => {
    const org = actingOrg(req, 'research');
    const { athleteHash, purpose, categories } = req.body;
    const { auditRef } = (await submit(org, 'consent', 'validateConsent', [], {
      transient: { athleteHash, declaredPurpose: purpose, requestedCategories: csv(categories) },
      endorsers: ATHLETE_PEERS,
    })) as { auditRef: string };
    const decision = (await evaluate(org, 'consent', 'getAccessDecision', [athleteHash, ORGS[org].msp, auditRef], ATHLETE_PEERS)) as {
      anyGranted: boolean;
    };
    res.status(decision.anyGranted ? 200 : 403).json(decision);
  }),
);

/**
 * Read-only ABAC preview: what would the research organisation receive?
 * Evaluated as ResearchMSP whatever the caller's session, because the decision
 * depends on the requester's identity; it writes nothing.
 */
app.post(
  '/api/access-request/preview',
  route(async (req, res) => {
    const { athleteHash, purpose, categories } = req.body;
    res.json(await evaluate('research', 'consent', 'previewConsentDecision', [athleteHash, purpose, csv(categories)], ATHLETE_PEERS));
  }),
);

// ---------------------------------------------------------- platform bootstrap

const DEMO_ATHLETE = createHash('sha256').update('platform-demo-athlete').digest('hex');
const LIST_VERSION = '2026-01';
const LIST_HASH = 'f'.repeat(64);

/** Best-effort: a step that has already been performed must not abort seeding. */
async function tolerate<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const detail = chaincodeMessage(error);
    if (/already exists|already registered|already committed|already been acknowledged|not awaiting receipt/i.test(detail)) return null;
    // eslint-disable-next-line no-console
    console.warn(`[seed] ${label}: ${detail.slice(0, 140)}`);
    return null;
  }
}

/**
 * Seed the ledger with a complete case so the platform has something to show,
 * then return the identifiers to read it back by. Writes real transactions;
 * idempotent.
 */
app.post(
  '/api/demo/seed',
  route(async (req, res) => {
    const sampleCode = String(req.body?.sampleCode ?? 'SMP-PLATFORM-0003');
    const athleteHash = String(req.body?.athleteHash ?? DEMO_ATHLETE);
    const seal = 'seal-platform-0003';

    if (!req.body?.force) {
      const [sample, consents] = await Promise.all([
        evaluate('nado', 'custody', 'getSample', [sampleCode]).catch(() => null),
        evaluate('athlete', 'consent', 'listConsents', [athleteHash], ATHLETE_PEERS).catch(() => []),
      ]);
      if (sample && Array.isArray(consents) && consents.length > 0) {
        res.json({ athleteHash, sampleCode, seeded: false, reason: 'already present' });
        return;
      }
    }

    await tolerate('prohibited list', () => submit('nado', 'custody', 'registerProhibitedList', [LIST_VERSION, LIST_HASH], { endorsers: NADO_LAB }));
    await tolerate('custody', () =>
      submit('nado', 'custody', 'initiateSampleCustody', [sampleCode, athleteHash, seal, digest('platform demo form')], { endorsers: NADO_LAB }),
    );
    await tolerate('acknowledge', () =>
      submit('athlete', 'custody', 'acknowledgeSampleCollection', [sampleCode, seal], { endorsers: ['AthleteMSP', 'NADOMSP'] }),
    );
    await tolerate('dispatch', () =>
      submit('nado', 'custody', 'proposeCustodyTransfer', [sampleCode, 'LabMSP', 'true', '48'], { endorsers: NADO_LAB }),
    );
    await tolerate('receipt', () =>
      submit('lab', 'custody', 'acceptCustodyTransfer', [sampleCode, '1', 'true', seal], { endorsers: NADO_LAB }),
    );
    // A negative result: the dashboard is an athlete's ordinary view, not a case file.
    await tolerate('analysis', () =>
      submit('lab', 'custody', 'recordSampleAnalysisResult', [sampleCode], {
        transient: { adverse: false, substance: '', prohibitedListVersion: LIST_VERSION, prohibitedListHash: LIST_HASH, laboratoryAccreditation: 'VERIFIED' },
        endorsers: NADO_LAB,
      }),
    );
    await tolerate('results management', () => submit('nado', 'custody', 'triggerResultsManagement', [sampleCode], { endorsers: NADO_LAB }));
    await tolerate('consent', () =>
      submit('athlete', 'consent', 'recordConsentTransaction', [], {
        transient: {
          athleteHash,
          grantedToMSP: 'ResearchMSP',
          purpose: 'cardiovascular_research',
          categories: 'abp_haematological,gps_accelerometry',
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: '2027-12-31T00:00:00.000Z',
          specialCategoryAuthorised: true,
        },
        endorsers: ATHLETE_PEERS,
      }),
    );

    const key = offchain.payloadKey(athleteHash, 'abp_haematological');
    if (!offchain.payloads.has(key) && (await offchain.ipfsReachable())) {
      const payload = Buffer.from(JSON.stringify({ athleteHash, category: 'abp_haematological', observations: [{ marker: 'HGB', value: 15.2 }] }));
      const stored = await offchain.store(payload);
      offchain.payloads.set(key, stored);
      await tolerate('offchain payload', () =>
        submit('lab', 'consent', 'registerOffchainPayload', [], {
          transient: { athleteHash, category: 'abp_haematological', cid: stored.cid, keyRef: stored.keyRef, commitment: stored.commitment },
          endorsers: ATHLETE_PEERS,
        }),
      );
    }
    res.json({ athleteHash, sampleCode, seeded: true });
  }),
);

/** GDPR Article 17 end to end: destroy the key, unpin, record the certificate and the 17(2) notice. */
app.post(
  '/api/offchain/erase',
  route(async (req, res) => {
    const { athleteHash, category } = req.body;
    const key = offchain.payloadKey(athleteHash, category);
    const record = offchain.payloads.get(key);
    if (!record) {
      res.status(404).json({ error: 'no off-chain payload registered for that category' });
      return;
    }
    const certificate = await offchain.erase(record);
    offchain.payloads.delete(key);
    const receipt = await submit(actingOrg(req, 'athlete'), 'consent', 'destroyIPFSAccessToken', [], {
      transient: { athleteHash, category, erasureCertificate: certificate },
      endorsers: ATHLETE_PEERS,
    });
    res.json({ certificate, receipt });
  }),
);

/** Which categories currently hold erasable off-chain content. */
app.get(
  '/api/offchain/:athleteHash',
  route(async (req, res) => {
    const held = [...offchain.payloads.entries()]
      .filter(([k]) => k.startsWith(`${req.params.athleteHash}:`))
      .map(([k, v]) => ({ category: k.split(':')[1], cid: v.cid, keyRef: v.keyRef }));
    res.json(held);
  }),
);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[gateway] listening on ${PORT}, channel ${process.env.CHANNEL ?? 'antidopingchannel'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    closeAll();
    process.exit(0);
  });
}
