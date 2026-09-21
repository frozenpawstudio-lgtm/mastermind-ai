import assert from "node:assert";

/*
 * PREPARE stage tests (Phase-1 Earning Operator).
 *
 * PREPARATION != SUBMISSION.
 *
 * PREPARE composes an owner-reviewable preparation package from persisted
 * state only. These tests assert:
 *   - valid preparation for a persisted opportunity,
 *   - platform-agnostic behaviour (no platform-specific branches),
 *   - unknown / empty platform stays truthful and usable,
 *   - grounding in persisted evidence and Owner data,
 *   - missing Owner information is reported, never invented,
 *   - no fabricated Owner facts appear in the output,
 *   - verification / eligibility / owner-fit / score / decision never change,
 *   - the package is preparation, never submission,
 *   - Upwork/Fiverr final submission remains MANUAL_OWNER_ONLY,
 *   - no external submission occurs,
 *   - read-only snapshot integrity across calls,
 *   - deterministic behaviour does not require a model provider.
 *
 * Requires the local worker to be running (see README test instructions).
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const authHeaders = OWNER_TOKEN ? { Authorization: `Bearer ${OWNER_TOKEN}` } : {};

async function getJson(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

function postJson(path, payload) {
  return getJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload)
  });
}

function del(path) {
  return getJson(path, { method: "DELETE", headers: authHeaders });
}

async function createOpportunity(overrides = {}) {
  const created = await postJson("/api/opportunities", {
    source: "prepare_test",
    title: "PREPARE stage test record",
    platform: "PrepareTest",
    description: "PREPARE stage test description",
    ...overrides
  });
  assert.strictEqual(created.res.status, 201, "Opportunity create must respond 201");
  return created.body.data;
}

async function runPrepareTests() {
  console.log(`Starting PREPARE stage tests against ${BASE_URL}...`);

  const health = await getJson("/api/health");
  assert.strictEqual(health.res.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  const createdIds = [];

  try {
    // --- 1. Valid opportunity preparation ---------------------------------
    const opp = await createOpportunity({ title: `PREPARE valid ${Date.now()}` });
    createdIds.push(opp.id);

    const prepared = await postJson(`/api/opportunities/${opp.id}/prepare`, {});
    assert.strictEqual(prepared.res.status, 200, "PREPARE must respond 200");
    assert.strictEqual(prepared.body.ok, true, "PREPARE must report ok:true");
    const pkg = prepared.body.data;
    assert.strictEqual(pkg.stage, "PREPARE", "Package must be labelled the PREPARE stage");
    assert.strictEqual(pkg.opportunity.id, opp.id, "Package must identify the opportunity");
    assert.ok(Array.isArray(pkg.materials) && pkg.materials.length > 0, "Package must contain prepared materials");
    assert.ok(Array.isArray(pkg.usedInformation), "Package must report what information was used");
    assert.ok(Array.isArray(pkg.missingInformation), "Package must report missing information");
    assert.ok(Array.isArray(pkg.nextActions) && pkg.nextActions.length > 0, "Package must recommend next preparation actions");
    console.log("✓ Valid opportunity preparation passed");

    // --- 1b. Explicit type selection --------------------------------------
    const typed = await postJson(`/api/opportunities/${opp.id}/prepare`, { type: "proposal" });
    assert.strictEqual(typed.res.status, 200, "Typed PREPARE must respond 200");
    assert.strictEqual(typed.body.data.materials.length, 1, "Explicit type must produce a single section");
    assert.strictEqual(typed.body.data.materials[0].type, "proposal", "Requested type must be honoured");
    assert.strictEqual(typed.body.data.requestedType, "proposal", "Requested type must be echoed");

    const unknownType = await postJson(`/api/opportunities/${opp.id}/prepare`, { type: "not_a_real_type" });
    assert.strictEqual(unknownType.res.status, 400, "Unknown preparation type must be rejected with 400");
    assert.ok(Array.isArray(unknownType.body.supportedTypes), "Rejection must list the supported types");
    console.log("✓ Explicit and invalid preparation types handled");

    const missingId = await postJson("/api/opportunities/does-not-exist/prepare", {});
    assert.strictEqual(missingId.res.status, 404, "Unknown opportunity must respond 404");
    console.log("✓ Unknown opportunity handled honestly");

    // --- 2. Platform-agnostic behaviour -----------------------------------
    // No section may branch on a specific platform, and every platform label
    // must be treated as unverified context.
    const platforms = [
      { platform: "Upwork", source: "upwork_manual" },
      { platform: "Fiverr", source: "fiverr_manual" },
      { platform: "Himalayas", source: "board" },
      { platform: "Working Nomads", source: "board" },
      { platform: "Toptal", source: "board" },
      { platform: "Direct Client", source: "referral" },
      { platform: "YouTube", source: "content" },
      { platform: "AI Data Work", source: "ai_marketplace" }
    ];

    for (const entry of platforms) {
      const record = await createOpportunity({
        title: `PREPARE platform ${entry.platform}`,
        platform: entry.platform,
        source: entry.source
      });
      createdIds.push(record.id);

      const res = await postJson(`/api/opportunities/${record.id}/prepare`, { type: "proposal" });
      assert.strictEqual(res.res.status, 200, `PREPARE must respond 200 for ${entry.platform}`);
      const data = res.body.data;
      assert.strictEqual(data.platform, entry.platform, `Package must carry the ${entry.platform} label`);
      assert.strictEqual(data.platformLabelIsContextOnly, true, `Platform label for ${entry.platform} must be context only`);
      assert.notStrictEqual(
        data.platformConnectionState,
        "CONNECTED",
        `${entry.platform} must never be reported CONNECTED by PREPARE`
      );
      assert.strictEqual(data.submissionStatus, "NOT_SUBMITTED", `${entry.platform} must remain NOT_SUBMITTED`);
    }
    console.log(`✓ Platform-agnostic behaviour passed (${platforms.length} platforms, none treated as connected)`);

    // --- 3. Unknown / empty platform handling -----------------------------
    for (const value of ["", "   ", "Some Platform That Does Not Exist"]) {
      const record = await createOpportunity({ title: `PREPARE platform edge ${value || "(empty)"}`, platform: value });
      createdIds.push(record.id);
      const res = await postJson(`/api/opportunities/${record.id}/prepare`, {});
      assert.strictEqual(res.res.status, 200, `PREPARE must remain usable for platform '${value}'`);
      assert.strictEqual(res.body.data.submissionStatus, "NOT_SUBMITTED", "Edge platform must remain NOT_SUBMITTED");
      assert.notStrictEqual(res.body.data.platformConnectionState, "CONNECTED", "Edge platform must not be CONNECTED");
      if (!String(value).trim()) {
        assert.ok(
          res.body.data.missingInformation.includes("opportunity.platform"),
          "Empty platform must be reported as missing information"
        );
      }
    }
    console.log("✓ Unknown/empty platform stays truthful and usable");

    // --- 4. Evidence / Owner-data grounding -------------------------------
    const grounded = await createOpportunity({ title: `PREPARE grounded ${Date.now()}` });
    createdIds.push(grounded.id);

    const fact = await postJson(`/api/opportunities/${grounded.id}/evidence`, {
      classification: "FACT",
      source: "prepare_test",
      content: "Client confirmed a fixed budget of 500 USD."
    });
    assert.strictEqual(fact.res.status, 201, "FACT evidence create must respond 201");

    const profilePost = await postJson("/api/owner/profile", {
      skills: "JavaScript, Cloudflare Workers",
      experience: "5 years building edge applications",
      location: "India",
      max_cost: "0",
      max_effort: "20 hours/week"
    });
    assert.strictEqual(profilePost.res.status, 200, "Owner profile update must respond 200");

    const groundedPrep = await postJson(`/api/opportunities/${grounded.id}/prepare`, { type: "proposal" });
    assert.strictEqual(groundedPrep.res.status, 200, "Grounded PREPARE must respond 200");
    const groundedData = groundedPrep.body.data;
    const groundedText = JSON.stringify(groundedData);

    assert.ok(
      groundedData.usedInformation.some((u) => String(u).startsWith("evidence.FACT")),
      "FACT evidence must be reported as used information"
    );
    assert.ok(
      groundedData.usedInformation.includes("owner_profile.skills"),
      "Owner skills must be reported as used information"
    );
    assert.ok(groundedText.includes("JavaScript, Cloudflare Workers"), "Output must include the real persisted Owner skills");
    assert.ok(groundedText.includes("Client confirmed a fixed budget of 500 USD."), "Output must include the real persisted FACT evidence");
    console.log("✓ Evidence/Owner-data grounding passed");

    // --- 5. Missing Owner information -------------------------------------
    // Remove the profile (empty values) and prepare an opportunity with no
    // description and no evidence: every gap must be reported, not filled in.
    await postJson("/api/owner/profile", {
      skills: "",
      experience: "",
      location: "",
      max_cost: "",
      max_effort: "",
      accessibility: "",
      other_criteria: ""
    });

    const bare = await createOpportunity({ title: `PREPARE bare ${Date.now()}`, description: "" });
    createdIds.push(bare.id);

    const barePrep = await postJson(`/api/opportunities/${bare.id}/prepare`, {});
    assert.strictEqual(barePrep.res.status, 200, "Bare PREPARE must respond 200");
    const bareData = barePrep.body.data;
    assert.ok(
      bareData.missingInformation.includes("owner_profile.skills"),
      "Missing Owner skills must be reported"
    );
    assert.ok(
      bareData.missingInformation.includes("evidence.FACT"),
      "Missing FACT evidence must be reported"
    );
    assert.ok(
      bareData.missingInformation.includes("opportunity.description"),
      "Missing description must be reported"
    );
    assert.ok(
      bareData.materials.some((m) => m.status === "DRAFT_NEEDS_OWNER_INPUT"),
      "Sections with gaps must be marked DRAFT_NEEDS_OWNER_INPUT"
    );
    console.log("✓ Missing Owner information reported");

    // --- 6. No fabricated Owner facts -------------------------------------
    // With an empty profile, no plausible-looking Owner fact may appear.
    const fabricatedMarkers = [
      "5 years",
      "10 years",
      "expert in",
      "certified",
      "worked with clients",
      "increased revenue",
      "successful projects"
    ];
    const bareText = JSON.stringify(bareData).toLowerCase();
    for (const marker of fabricatedMarkers) {
      assert.ok(
        !bareText.includes(marker),
        `Output must not fabricate Owner facts (found '${marker}')`
      );
    }
    assert.ok(
      JSON.stringify(bareData).includes("[OWNER INPUT REQUIRED]"),
      "Absent Owner facts must be surfaced as OWNER INPUT REQUIRED placeholders"
    );
    console.log("✓ No fabricated Owner facts");

    // --- 7. No mutation of authoritative state ----------------------------
    const before = await getJson(`/api/opportunities/${grounded.id}`);
    await postJson(`/api/opportunities/${grounded.id}/prepare`, {});
    await postJson(`/api/opportunities/${grounded.id}/prepare`, { type: "cover_letter" });
    await postJson(`/api/opportunities/${grounded.id}/prepare`, { type: "submission_checklist" });
    const after = await getJson(`/api/opportunities/${grounded.id}`);

    for (const field of ["verification_status", "eligibility_status", "owner_fit_status", "score", "decision"]) {
      assert.strictEqual(
        after.body.data[field],
        before.body.data[field],
        `PREPARE must not change ${field}`
      );
    }
    console.log("✓ Authoritative state unchanged (verification/eligibility/owner-fit/score/decision)");

    // --- 8. PREPARATION != SUBMISSION -------------------------------------
    const subCheck = await postJson(`/api/opportunities/${grounded.id}/prepare`, { type: "submission_checklist" });
    assert.strictEqual(subCheck.res.status, 200, "Submission checklist PREPARE must respond 200");
    const subData = subCheck.body.data;
    assert.strictEqual(subData.submissionStatus, "NOT_SUBMITTED", "Submission status must be NOT_SUBMITTED");
    assert.strictEqual(subData.preparationIsSubmission, false, "Preparation must never equal submission");
    assert.strictEqual(subData.ownerReviewRequired, true, "Owner review must be required");
    for (const material of subData.materials) {
      assert.strictEqual(material.submitted, false, "No material may be marked submitted");
      assert.strictEqual(material.ownerReviewRequired, true, "Every material must require Owner review");
    }
    const submitText = JSON.stringify(subData).toUpperCase();
    for (const claim of ["SUBMITTED SUCCESSFULLY", "APPLIED TO", "APPLICATION SENT", "MESSAGE SENT", "PAYMENT MADE"]) {
      assert.ok(!submitText.includes(claim), `Output must not claim '${claim}'`);
    }
    console.log("✓ PREPARATION != SUBMISSION");

    // --- 9. Upwork/Fiverr final submission remains MANUAL_OWNER_ONLY -------
    const perms = await getJson("/api/permissions");
    assert.strictEqual(perms.res.status, 200, "Permissions must respond 200");
    const manualRule = perms.body.data.rules.find((r) => r.approval === "MANUAL_OWNER_ONLY");
    assert.ok(manualRule, "MANUAL_OWNER_ONLY rule must still exist");
    assert.strictEqual(manualRule.risk, "OWNER_CONTROLLED", "Final submission must remain OWNER_CONTROLLED");
    assert.match(manualRule.capability, /upwork\/fiverr/i, "Rule must cover upwork/fiverr final submission");
    console.log("✓ Upwork/Fiverr final submission remains MANUAL_OWNER_ONLY");

    // --- 10. No external submission occurs --------------------------------
    // PREPARE runs on the AI/Browser-free deterministic path. The worker holds
    // only AI, BROWSER, ASSETS and the Durable Object bindings, and PREPARE
    // issues no outbound fetch. Assert the connection report is unchanged and
    // no platform became CONNECTED as a side effect of preparing.
    const conns = await getJson("/api/connections");
    assert.strictEqual(conns.res.status, 200, "Connections must respond 200");
    const earningPlatformEntries = conns.body.data.services.filter((s) => s.kind === "earning_platform");
    for (const svc of conns.body.data.services) {
      if (svc.state === "CONNECTED") {
        assert.strictEqual(svc.verified, true, `CONNECTED service ${svc.service} must be verified`);
      }
    }
    assert.ok(
      conns.body.data.connectedCount <= 3,
      "Only the three real Cloudflare bindings may report CONNECTED"
    );
    console.log(
      `✓ No external submission path (connected=${conns.body.data.connectedCount}, earning platforms listed=${earningPlatformEntries.length})`
    );

    // --- 11. Read-only / snapshot integrity -------------------------------
    const snapshot = async () => JSON.stringify({
      opportunities: (await getJson("/api/opportunities")).body.data,
      evidence: (await getJson("/api/evidence")).body.data,
      ownerProfile: (await getJson("/api/owner/profile")).body.data
    });
    // Ignore updated_at churn by comparing the authoritative engine fields and
    // record identities only.
    const coreSnapshot = async () => {
      const opps = (await getJson("/api/opportunities")).body.data;
      const ev = (await getJson("/api/evidence")).body.data;
      const prof = (await getJson("/api/owner/profile")).body.data;
      return JSON.stringify({
        opps: opps.map((o) => [o.id, o.verification_status, o.eligibility_status, o.owner_fit_status, o.score, o.decision]),
        ev: ev.map((e) => [e.id, e.classification, e.content]),
        prof: prof ? [prof.skills, prof.experience, prof.location, prof.max_cost, prof.max_effort] : null
      });
    };

    const snapBefore = await coreSnapshot();
    await postJson(`/api/opportunities/${grounded.id}/prepare`, {});
    await postJson(`/api/opportunities/${grounded.id}/prepare`, { type: "pricing_draft" });
    const snapAfter = await coreSnapshot();
    assert.strictEqual(snapAfter, snapBefore, "PREPARE must not mutate opportunities, evidence or owner profile");
    console.log("✓ Read-only snapshot integrity passed");

    // --- 12. Model-unavailable behaviour ----------------------------------
    // PREPARE v1 is fully deterministic and requires no model provider, so it
    // must succeed regardless of AI availability, and must report availability
    // truthfully rather than faking a model-backed result.
    const healthAgain = await getJson("/api/health");
    assert.strictEqual(typeof healthAgain.body.aiConnected, "boolean", "Health must report a boolean aiConnected");
    const prepNoModel = await postJson(`/api/opportunities/${grounded.id}/prepare`, {});
    assert.strictEqual(
      prepNoModel.res.status,
      200,
      "PREPARE must remain available without depending on a model provider"
    );
    assert.ok(
      !JSON.stringify(prepNoModel.body.data).includes('"modelGenerated":true'),
      "PREPARE must not claim model-generated output when no model call is made"
    );
    console.log(
      `✓ Model-unavailable behaviour truthful (aiConnected=${healthAgain.body.aiConnected}, prepare independent of model)`
    );

    // --- Method guard -----------------------------------------------------
    // PREPARE is POST-only. GET and every other unsupported method must 405.
    const getRes = await getJson(`/api/opportunities/${grounded.id}/prepare`);
    assert.strictEqual(getRes.res.status, 405, "GET must respond 405 (PREPARE is POST-only)");
    const putRes = await getJson(`/api/opportunities/${grounded.id}/prepare`, {
      method: "PUT",
      headers: authHeaders
    });
    assert.strictEqual(putRes.res.status, 405, "PUT must respond 405");
    const patchRes = await getJson(`/api/opportunities/${grounded.id}/prepare`, {
      method: "PATCH",
      headers: authHeaders
    });
    assert.strictEqual(patchRes.res.status, 405, "PATCH must respond 405");
    const methodRes = await getJson(`/api/opportunities/${grounded.id}/prepare`, {
      method: "DELETE",
      headers: authHeaders
    });
    assert.strictEqual(methodRes.res.status, 405, "Unsupported method must respond 405");
    console.log("✓ Method guard passed (GET/PUT/PATCH/DELETE → 405)");

    // --- Invalid JSON body ------------------------------------------------
    const badJson = await getJson(`/api/opportunities/${grounded.id}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: "{not valid json"
    });
    assert.strictEqual(badJson.res.status, 400, "Invalid JSON body must respond 400");
    console.log("✓ Invalid JSON body rejected (400)");

    console.log("\nALL PREPARE STAGE TESTS PASSED SUCCESSFULLY!");
  } finally {
    // Cleanup — remove only the records this suite created.
    for (const id of createdIds) {
      await del(`/api/opportunities/${id}`);
    }
    console.log(`Cleanup complete (${createdIds.length} records removed).`);
  }
}

runPrepareTests().catch((err) => {
  console.error("PREPARE stage test failure:", err);
  process.exit(1);
});
