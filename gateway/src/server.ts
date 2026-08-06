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

async function submit(org: OrgKey, cc: 'custody' | 'consent', fn: string, args: string[]) {
  const contract = await contractFor(org, cc);
  return decode(await contract.submitTransaction(fn, ...args));
}

async function evaluate(org: OrgKey, cc: 'custody' | 'consent', fn: string, args: string[]) {
  const contract = await contractFor(org, cc);
  return decode(await contract.evaluateTransaction(fn, ...args));
}

/**
 * Submit while restricting endorsement to named organizations.
 *
 * Normally the gateway lets service discovery assemble an endorsement plan that
 * satisfies the policy. Pinning the endorser set is what makes the §4.1
 * collusion mitigation demonstrable through the API: a caller can attempt a
 * results-management write with a single organization's endorsement and observe
 * the network reject it, rather than having to take the claim on trust.
 */
async function submitFrom(
  org: OrgKey,
  cc: 'custody' | 'consent',
  fn: string,
  args: string[],
  endorsingOrganizations: string[],
) {
  const contract = await contractFor(org, cc);
  const proposal = contract.newProposal(fn, { arguments: args, endorsingOrganizations });
  const transaction = await proposal.endorse();
  const submitted = await transaction.submit();
  const status = await submitted.getStatus();
  if (!status.successful) {
    throw new Error(`transaction ${status.transactionId} failed validation: code ${status.code}`);
  }
  return decode(transaction.getResult());
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
      orderer: 'orderer.antidoping.org:7050 (Raft)',
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

app.post(
  '/api/prohibited-list',
  route(async (req, res) => {
    const { version, hash } = req.body;
    res.json(await submit(actingOrg(req, 'nado'), 'custody', 'registerProhibitedList', [version, hash]));
  }),
);

/** WADA Article 5.3 */
app.post(
  '/api/samples',
  route(async (req, res) => {
    const { sampleCode, athleteHash, sealedContainerHash, collectionLocation } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'initiateSampleCustody', [
        sampleCode,
        athleteHash,
        sealedContainerHash,
        collectionLocation,
      ]),
    );
  }),
);

/** WADA Article 5.4 */
app.post(
  '/api/samples/:code/transfers',
  route(async (req, res) => {
    const { phase, fromMSP, toMSP, containerSealIntact, transferWindowHours } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'recordCustodyTransfer', [
        req.params.code,
        phase,
        fromMSP,
        toMSP,
        String(containerSealIntact ?? true),
        String(transferWindowHours ?? 48),
      ]),
    );
  }),
);

/** WADA Article 2.1 */
app.post(
  '/api/samples/:code/analysis',
  route(async (req, res) => {
    const { adverse, substance, prohibitedListVersion, prohibitedListHash, laboratoryAccreditation } =
      req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'lab'), 'custody', 'recordSampleAnalysisResult', [
        req.params.code,
        String(adverse),
        substance ?? '',
        prohibitedListVersion,
        prohibitedListHash,
        laboratoryAccreditation ?? 'VERIFIED',
      ]),
    );
  }),
);

/**
 * WADA Article 7.1 — runs the Table 2 decision engine on-chain.
 *
 * `?endorsers=NADOMSP` pins the endorsing organizations. Used to demonstrate
 * that a single organization cannot alter committed results-management state:
 * the write is rejected at validation with an endorsement policy failure.
 */
app.post(
  '/api/samples/:code/results-management',
  route(async (req, res) => {
    const org = actingOrg(req, 'nado');
    const pinned = String(req.query.endorsers ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const result = pinned.length
      ? await submitFrom(org, 'custody', 'triggerResultsManagement', [req.params.code], pinned)
      : await submit(org, 'custody', 'triggerResultsManagement', [req.params.code]);
    res.json(result);
  }),
);

/** WADA Article 2.4 — whereabouts filing or failure. */
app.post(
  '/api/whereabouts',
  route(async (req, res) => {
    const { athleteHash, filingId, failure, ledgerVerified } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'recordWhereaboutsStatus', [
        athleteHash,
        filingId,
        String(failure ?? true),
        String(ledgerVerified ?? true),
      ]),
    );
  }),
);

/** Athlete Biological Passport evaluation — feeds conditions Q003 and Q004. */
app.post(
  '/api/passport-evaluation',
  route(async (req, res) => {
    const { athleteHash, anomaly, expertPanelRequired } = req.body;
    await submit(actingOrg(req, 'lab'), 'custody', 'recordPassportEvaluation', [
      athleteHash,
      String(anomaly ?? true),
      String(expertPanelRequired ?? true),
    ]);
    res.status(201).json({ athleteHash, anomaly, expertPanelRequired });
  }),
);

/** Register an off-chain payload: only the CID and key reference go on-ledger. */
app.post(
  '/api/offchain-payload',
  route(async (req, res) => {
    const { athleteHash, category, cid, keyRef, plaintextDigest } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'lab'), 'consent', 'registerOffchainPayload', [
        athleteHash,
        category,
        cid,
        keyRef,
        plaintextDigest,
      ]),
    );
  }),
);

/** WADA Article 7.3 */
app.post(
  '/api/samples/:code/notify',
  route(async (req, res) => {
    res.json(await submit(actingOrg(req, 'nado'), 'custody', 'notifyAthleteOfAAF', [req.params.code]));
  }),
);

/** GDPR Article 22 oversight record, prerequisite for Article 7.9. */
app.post(
  '/api/samples/:code/oversight',
  route(async (req, res) => {
    const { reviewerId, decision, rationale } = req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'enforceOversightRequirement', [
        req.params.code,
        reviewerId,
        decision,
        rationale,
      ]),
    );
  }),
);

/** WADA Article 7.9 — refused unless an oversight record exists. */
app.post(
  '/api/samples/:code/provisional-suspension',
  route(async (req, res) => {
    res.status(201).json(
      await submit(actingOrg(req, 'nado'), 'custody', 'recordProvisionalSuspension', [
        req.params.code,
        req.body.groundsArticle ?? 'Article 7.9',
      ]),
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

/** WADA Article 14.1 — the confidentiality gate, evaluated as the caller. */
app.get(
  '/api/samples/:code/results',
  route(async (req, res) => {
    const decision = (await evaluate(
      actingOrg(req, 'nado'),
      'custody',
      'enforceResultsConfidentiality',
      [req.params.code],
    )) as { granted: boolean };
    res.status(decision.granted ? 200 : 403).json(decision);
  }),
);

/** Table 2 evaluated directly, for the decision-table explorer in the UI. */
app.post(
  '/api/decision-table/evaluate',
  route(async (req, res) => {
    res.json(
      await evaluate(actingOrg(req, 'nado'), 'custody', 'evaluateDecisionTable', [
        JSON.stringify(req.body),
      ]),
    );
  }),
);

// --------------------------------------------------------------- consent

/** GDPR Article 7 — only the athlete organization may write consent. */
app.post(
  '/api/consent',
  route(async (req, res) => {
    const { athleteHash, grantedToMSP, purpose, categories, validFrom, validUntil, specialCategoryAuthorised } =
      req.body;
    res.status(201).json(
      await submit(actingOrg(req, 'athlete'), 'consent', 'recordConsentTransaction', [
        athleteHash,
        grantedToMSP,
        purpose,
        Array.isArray(categories) ? categories.join(',') : String(categories),
        validFrom,
        validUntil,
        String(specialCategoryAuthorised ?? false),
      ]),
    );
  }),
);

/** GDPR Article 7(3) */
app.delete(
  '/api/consent',
  route(async (req, res) => {
    const { athleteHash, grantedToMSP, purpose } = req.body;
    res.json(
      await submit(actingOrg(req, 'athlete'), 'consent', 'withdrawConsent', [
        athleteHash,
        grantedToMSP,
        purpose,
      ]),
    );
  }),
);

app.get(
  '/api/consent/:athleteHash',
  route(async (req, res) => {
    res.json(
      await evaluate(actingOrg(req, 'athlete'), 'consent', 'listConsents', [req.params.athleteHash]),
    );
  }),
);

/** The ABAC gate. Writes an access-audit record for every decision. */
app.post(
  '/api/access-request',
  route(async (req, res) => {
    const { athleteHash, purpose, categories } = req.body;
    const decision = (await submit(actingOrg(req, 'research'), 'consent', 'validateConsent', [
      athleteHash,
      purpose,
      Array.isArray(categories) ? categories.join(',') : String(categories),
    ])) as { anyGranted: boolean };
    res.status(decision.anyGranted ? 200 : 403).json(decision);
  }),
);

/**
 * Read-only ABAC preview: what would the research organization receive?
 *
 * Deliberately evaluated as ResearchMSP whatever the caller's session, because
 * the chaincode decides from the *caller's* identity and the question being
 * asked is about the requester, not the viewer. It is safe to expose to an
 * athlete: it discloses only the entitlement of a third party to that athlete's
 * own data, and writes nothing.
 */
app.post(
  '/api/access-request/preview',
  route(async (req, res) => {
    const { athleteHash, purpose, categories } = req.body;
    res.json(
      await evaluate('research', 'consent', 'previewConsentDecision', [
        athleteHash,
        purpose,
        Array.isArray(categories) ? categories.join(',') : String(categories),
      ]),
    );
  }),
);

/** GDPR Article 17 */
app.post(
  '/api/erasure',
  route(async (req, res) => {
    const { athleteHash, category, erasureCertificate } = req.body;
    res.json(
      await submit(actingOrg(req, 'athlete'), 'consent', 'destroyIPFSAccessToken', [
        athleteHash,
        category,
        JSON.stringify(erasureCertificate),
      ]),
    );
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
    if (/already exists|already registered/i.test(detail)) return null;
    // eslint-disable-next-line no-console
    console.warn(`[seed] ${label}: ${detail.slice(0, 140)}`);
    return null;
  }
}

/**
 * Seed the ledger with a complete, realistic case so the platform has something
 * to display, then return the identifiers to read it back by.
 *
 * This writes real transactions; it does not fabricate a view. Everything the
 * dashboard shows afterwards is read from the ledger. Idempotent: re-running it
 * against an already-seeded network is a no-op.
 */
app.post(
  '/api/demo/seed',
  route(async (req, res) => {
    const sampleCode = String(req.body?.sampleCode ?? 'SMP-PLATFORM-0002');
    const athleteHash = String(req.body?.athleteHash ?? DEMO_ATHLETE);

    // Seeding is idempotent but not free: every step is a transaction, and the
    // page calls this on load. If the case is already on the ledger there is
    // nothing to write, so return the identifiers and skip the round trips.
    if (!req.body?.force) {
      const [sample, consents] = await Promise.all([
        evaluate('nado', 'custody', 'getSample', [sampleCode]).catch(() => null),
        evaluate('athlete', 'consent', 'listConsents', [athleteHash]).catch(() => []),
      ]);
      if (sample && Array.isArray(consents) && consents.length > 0) {
        res.json({ athleteHash, sampleCode, seeded: false, reason: 'already present' });
        return;
      }
    }

    await tolerate('prohibited list', () =>
      submit('nado', 'custody', 'registerProhibitedList', [LIST_VERSION, LIST_HASH]),
    );
    await tolerate('custody', () =>
      submit('nado', 'custody', 'initiateSampleCustody', [
        sampleCode, athleteHash, 'seal-platform-0001', 'Tunis National Testing Centre',
      ]),
    );
    // A custody transfer is an append, not an upsert: re-running the seed would
    // legitimately add a second handoff every time and the chain would grow a
    // duplicate pair per call. Only add phases the chain does not already hold.
    const existing = (await evaluate('nado', 'custody', 'getCustodyChain', [sampleCode]).catch(
      () => [],
    )) as { phase: string }[];
    const recorded = new Set((existing || []).map((e) => e.phase));

    for (const [phase, org] of [
      ['TRANSPORT_HANDOFF', 'nado'],
      ['LABORATORY_RECEIPT', 'lab'],
    ] as [string, OrgKey][]) {
      if (recorded.has(phase)) continue;
      await tolerate(phase, () =>
        submit(org, 'custody', 'recordCustodyTransfer', [
          sampleCode, phase, 'NADOMSP', 'LabMSP', 'true', '48',
        ]),
      );
    }
    // A negative result: the dashboard is an athlete's ordinary view, not a case file.
    await tolerate('analysis', () =>
      submit('lab', 'custody', 'recordSampleAnalysisResult', [
        sampleCode, 'false', '', LIST_VERSION, LIST_HASH, 'VERIFIED',
      ]),
    );
    await tolerate('results management', () =>
      submit('nado', 'custody', 'triggerResultsManagement', [sampleCode]),
    );

    // Two categories shared, four withheld - the §3.5 starting position.
    for (const [purpose, categories] of [
      ['cardiovascular_research', 'abp_haematological,gps_accelerometry'],
    ] as [string, string][]) {
      await tolerate('consent', () =>
        submit('athlete', 'consent', 'recordConsentTransaction', [
          athleteHash, 'ResearchMSP', purpose, categories,
          '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'true',
        ]),
      );
    }

    // An off-chain payload so the Article 17 control operates on real content.
    const key = offchain.payloadKey(athleteHash, 'abp_haematological');
    if (!offchain.payloads.has(key) && (await offchain.ipfsReachable())) {
      const payload = Buffer.from(
        JSON.stringify({
          athleteHash,
          category: 'abp_haematological',
          observations: [
            { marker: 'HGB', value: 15.2, unit: 'g/dL' },
            { marker: 'RET%', value: 1.06, unit: '%' },
          ],
        }),
      );
      const stored = await offchain.store(payload);
      offchain.payloads.set(key, stored);
      await tolerate('offchain payload', () =>
        submit('lab', 'consent', 'registerOffchainPayload', [
          athleteHash, 'abp_haematological', stored.cid, stored.keyRef, stored.plaintextDigest,
        ]),
      );
    }

    res.json({ athleteHash, sampleCode, seeded: true });
  }),
);

/** GDPR Article 17 end to end: destroy the key, unpin, record the certificate. */
app.post(
  '/api/offchain/erase',
  route(async (req, res) => {
    const { athleteHash, category } = req.body;
    const key = offchain.payloadKey(athleteHash, category);
    const record = offchain.payloads.get(key);
    if (!record) {
      res.status(404).json({
        error: 'no off-chain payload registered for that category',
        hint: 'only categories with stored biological data can be erased',
      });
      return;
    }
    const certificate = await offchain.erase(record);
    offchain.payloads.delete(key);
    const receipt = await submit(actingOrg(req, 'athlete'), 'consent', 'destroyIPFSAccessToken', [
      athleteHash, category, JSON.stringify(certificate),
    ]);
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
