#!/usr/bin/env python3
"""
Apify Actor Benchmark — Australian Real Estate Scrapers
Runs each candidate actor on a small test (1 suburb), compares output quality.

Usage:
  1. Set APIFY_TOKEN environment variable (from apify.com → Settings → Integrations → API Token)
  2. Run: python3 scripts/apify-actor-benchmark.py

Tests 3 categories:
  A) Domain.com.au AGENT scrapers (4 candidates)
  B) Domain.com.au PROPERTY scrapers (4 candidates)
  C) realestate.com.au scrapers (3 candidates)

Each test runs with a single suburb (Strathfield NSW) to keep costs minimal (~$0.50 total).
"""

import os
import sys
import json
import time
import urllib.request
import ssl

APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "")
if not APIFY_TOKEN:
    print("ERROR: Set APIFY_TOKEN environment variable first.")
    print("  Get it from: apify.com → Settings → Integrations → Personal API tokens")
    print("  Then run: APIFY_TOKEN=apify_api_xxxxx python3 scripts/apify-actor-benchmark.py")
    sys.exit(1)

ctx = ssl.create_default_context()
BASE = "https://api.apify.com/v2"
HEADERS = {"Authorization": f"Bearer {APIFY_TOKEN}", "Content-Type": "application/json"}

# ── Test suburb ──────────────────────────────────────────────────────────────
TEST_SUBURB = "Strathfield"
TEST_STATE = "NSW"
TEST_POSTCODE = "2135"

# ── Candidate actors to test ────────────────────────────────────────────────

AGENT_SCRAPERS = [
    {
        "name": "shahidirfan/domain-com-au-real-estate-agents-scraper",
        "label": "shahidirfan Domain Agents",
        "input": {"location": f"{TEST_SUBURB}, {TEST_STATE}", "maxItems": 50},
    },
    {
        "name": "easyapi/domain-com-au-real-estate-agents-scraper",
        "label": "easyapi Domain Agents",
        "input": {"searchQuery": TEST_SUBURB, "maxResults": 50},
    },
    {
        "name": "scrapestorm/domain-com-au-real-estate-agents-scraper---cheap",
        "label": "scrapestorm Domain Agents Cheap",
        "input": {"location": f"{TEST_SUBURB}", "maxItems": 50},
    },
    {
        "name": "websift/australian-realestate-agent-collector",
        "label": "websift REA Agent Collector",
        "input": {"location": f"{TEST_SUBURB} {TEST_STATE} {TEST_POSTCODE}", "maxResults": 50, "contactFilter": "any"},
    },
]

PROPERTY_SCRAPERS = [
    {
        "name": "shahidirfan/domain-com-au-property-scraper",
        "label": "shahidirfan Domain Property",
        "input": {"searchUrl": f"https://www.domain.com.au/sale/{TEST_SUBURB.lower()}-{TEST_STATE.lower()}-{TEST_POSTCODE}/", "maxItems": 30},
    },
    {
        "name": "fatihtahta/domain-com-au-scraper",
        "label": "fatihtahta Domain $1/1K",
        "input": {"startUrls": [{"url": f"https://www.domain.com.au/sale/{TEST_SUBURB.lower()}-{TEST_STATE.lower()}-{TEST_POSTCODE}/"}], "maxItems": 30},
    },
    {
        "name": "scrapestorm/domain-com-au-property-scraper---cheap",
        "label": "scrapestorm Domain Property Cheap",
        "input": {"searchUrl": f"https://www.domain.com.au/sale/{TEST_SUBURB.lower()}-{TEST_STATE.lower()}-{TEST_POSTCODE}/", "maxItems": 30},
    },
    {
        "name": "scrapemind/domaincomau-scraper",
        "label": "scrapemind Efficient Domain",
        "input": {"searchUrl": f"https://www.domain.com.au/sale/{TEST_SUBURB.lower()}-{TEST_STATE.lower()}-{TEST_POSTCODE}/", "maxItems": 30},
    },
]

REA_SCRAPERS = [
    {
        "name": "abotapi/realestate-au-scraper",
        "label": "abotapi REA Scraper",
        "input": {"searchUrl": f"https://www.realestate.com.au/buy/in-{TEST_SUBURB.lower()},+{TEST_STATE.lower()}+{TEST_POSTCODE}/list-1", "maxItems": 30},
    },
    {
        "name": "azzouzana/real-estate-au-scraper-pro",
        "label": "azzouzana REA PRO",
        "input": {"startUrls": [{"url": f"https://www.realestate.com.au/buy/in-{TEST_SUBURB.lower()},+{TEST_STATE.lower()}+{TEST_POSTCODE}/list-1"}], "maxItems": 30},
    },
    {
        "name": "scrapemind/ausscraper",
        "label": "scrapemind Aussie Scraper",
        "input": {"searchUrl": f"https://www.realestate.com.au/buy/in-{TEST_SUBURB.lower()},+{TEST_STATE.lower()}+{TEST_POSTCODE}/list-1", "maxItems": 30},
    },
]


def run_actor(actor_id, input_data, timeout_secs=120):
    """Run an Apify actor and wait for results."""
    url = f"{BASE}/acts/{actor_id}/runs?timeout={timeout_secs}&waitForFinish={timeout_secs}"
    body = json.dumps(input_data).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers=HEADERS)

    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=timeout_secs + 30)
        run_data = json.loads(resp.read())
        run_id = run_data.get("data", {}).get("id")
        status = run_data.get("data", {}).get("status")

        if not run_id:
            return {"error": "No run ID returned", "raw": str(run_data)[:200]}

        # If still running, poll
        if status in ("RUNNING", "READY"):
            for _ in range(30):
                time.sleep(5)
                poll_url = f"{BASE}/actor-runs/{run_id}"
                poll_req = urllib.request.Request(poll_url, headers=HEADERS)
                poll_resp = urllib.request.urlopen(poll_req, context=ctx)
                poll_data = json.loads(poll_resp.read())
                status = poll_data.get("data", {}).get("status")
                if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
                    break

        if status != "SUCCEEDED":
            return {"error": f"Run status: {status}", "run_id": run_id}

        # Get dataset items
        dataset_id = run_data.get("data", {}).get("defaultDatasetId")
        if not dataset_id:
            return {"error": "No dataset ID", "run_id": run_id}

        items_url = f"{BASE}/datasets/{dataset_id}/items?limit=100"
        items_req = urllib.request.Request(items_url, headers=HEADERS)
        items_resp = urllib.request.urlopen(items_req, context=ctx)
        items = json.loads(items_resp.read())

        return {"success": True, "items": items, "count": len(items), "run_id": run_id, "status": status}

    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"error": f"HTTP {e.code}: {body[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def analyze_agent_results(items):
    """Score agent scraper output quality."""
    if not items:
        return {"score": 0, "details": "No results"}

    total = len(items)
    has_name = sum(1 for i in items if i.get("name") or i.get("agentName") or i.get("full_name") or i.get("firstName"))
    has_phone = sum(1 for i in items if i.get("phone") or i.get("phoneNumber") or i.get("mobile"))
    has_email = sum(1 for i in items if i.get("email"))
    has_agency = sum(1 for i in items if i.get("agency") or i.get("agencyName") or i.get("agency_name"))
    has_suburb = sum(1 for i in items if i.get("suburb") or i.get("location") or i.get("area"))
    has_listings = sum(1 for i in items if i.get("totalListings") or i.get("listings") or i.get("propertiesForSale") or i.get("total_listings"))
    has_sold = sum(1 for i in items if i.get("propertiesSold") or i.get("sold") or i.get("totalSold"))
    has_rating = sum(1 for i in items if i.get("rating") or i.get("reviews") or i.get("reviewCount"))
    has_profile_url = sum(1 for i in items if i.get("url") or i.get("profileUrl") or i.get("agentUrl"))

    # Score: weighted by importance to our use case
    score = 0
    score += (has_name / total) * 20        # Name is essential
    score += (has_phone / total) * 20       # Phone = actionable
    score += (has_email / total) * 15       # Email = actionable
    score += (has_agency / total) * 15      # Agency = context
    score += (has_listings / total) * 10    # Listings = activity signal
    score += (has_sold / total) * 10        # Sold = performance
    score += (has_rating / total) * 5       # Rating = quality signal
    score += (has_profile_url / total) * 5  # URL = reference

    # Sample first record keys for inspection
    sample_keys = list(items[0].keys())[:20] if items else []

    return {
        "score": round(score, 1),
        "total": total,
        "has_name": has_name,
        "has_phone": has_phone,
        "has_email": has_email,
        "has_agency": has_agency,
        "has_listings": has_listings,
        "has_sold": has_sold,
        "has_rating": has_rating,
        "has_url": has_profile_url,
        "sample_keys": sample_keys,
        "sample_record": items[0] if items else None,
    }


def analyze_property_results(items):
    """Score property/listing scraper output quality."""
    if not items:
        return {"score": 0, "details": "No results"}

    total = len(items)
    has_address = sum(1 for i in items if i.get("address") or i.get("propertyAddress") or i.get("displayAddress"))
    has_price = sum(1 for i in items if i.get("price") or i.get("askingPrice") or i.get("priceDetails") or i.get("displayPrice"))
    has_agent = sum(1 for i in items if i.get("agent") or i.get("agentName") or i.get("agents") or i.get("listingAgent"))
    has_agency = sum(1 for i in items if i.get("agency") or i.get("agencyName"))
    has_beds = sum(1 for i in items if i.get("beds") or i.get("bedrooms") or i.get("features", {}).get("beds") if isinstance(i.get("features"), dict) else i.get("beds"))
    has_type = sum(1 for i in items if i.get("propertyType") or i.get("type") or i.get("property_type"))
    has_suburb = sum(1 for i in items if i.get("suburb") or i.get("location"))
    has_listed_date = sum(1 for i in items if i.get("listedDate") or i.get("dateListed") or i.get("listed_date"))
    has_url = sum(1 for i in items if i.get("url") or i.get("listingUrl") or i.get("link"))

    score = 0
    score += (has_address / total) * 20
    score += (has_price / total) * 15
    score += (has_agent / total) * 20       # Agent attribution is key for us
    score += (has_agency / total) * 10
    score += (has_suburb / total) * 10
    score += (has_beds / total) * 5
    score += (has_type / total) * 5
    score += (has_listed_date / total) * 10
    score += (has_url / total) * 5

    sample_keys = list(items[0].keys())[:20] if items else []

    return {
        "score": round(score, 1),
        "total": total,
        "has_address": has_address,
        "has_price": has_price,
        "has_agent": has_agent,
        "has_agency": has_agency,
        "has_suburb": has_suburb,
        "has_listed_date": has_listed_date,
        "sample_keys": sample_keys,
        "sample_record": items[0] if items else None,
    }


def run_benchmark(category_name, actors, analyzer):
    """Run all actors in a category and compare."""
    print(f"\n{'='*70}")
    print(f"  {category_name}")
    print(f"  Test suburb: {TEST_SUBURB}, {TEST_STATE} {TEST_POSTCODE}")
    print(f"{'='*70}")

    results = []

    for actor in actors:
        print(f"\n  Running: {actor['label']} ({actor['name']})...")
        start = time.time()
        result = run_actor(actor["name"], actor["input"])
        elapsed = round(time.time() - start, 1)

        if result.get("error"):
            print(f"    ❌ FAILED: {result['error'][:120]}")
            results.append({"label": actor["label"], "status": "FAILED", "error": result["error"][:200], "time": elapsed, "score": 0})
            continue

        analysis = analyzer(result.get("items", []))
        print(f"    ✅ {result['count']} results in {elapsed}s — Score: {analysis['score']}/100")
        print(f"    Fields: name={analysis.get('has_name','?')}/{analysis.get('total','?')} phone={analysis.get('has_phone','?')} email={analysis.get('has_email','?')} agency={analysis.get('has_agency','?')}")
        print(f"    Sample keys: {analysis.get('sample_keys', [])[:12]}")

        results.append({
            "label": actor["label"],
            "actor": actor["name"],
            "status": "OK",
            "count": result["count"],
            "time": elapsed,
            "score": analysis["score"],
            "analysis": analysis,
        })

    # Rank by score
    ranked = sorted(results, key=lambda r: r["score"], reverse=True)
    print(f"\n  {'─'*60}")
    print(f"  RANKING — {category_name}")
    print(f"  {'─'*60}")
    for i, r in enumerate(ranked):
        medal = ["🥇", "🥈", "🥉", "  "][min(i, 3)]
        status = f"Score {r['score']}/100 — {r.get('count', 0)} results in {r['time']}s" if r["status"] == "OK" else f"FAILED: {r.get('error', '?')[:60]}"
        print(f"  {medal} {r['label']:40s} {status}")

    # Save detailed results
    return ranked


if __name__ == "__main__":
    print("╔══════════════════════════════════════════════════════════════════╗")
    print("║  APIFY ACTOR BENCHMARK — Australian Real Estate Scrapers       ║")
    print("║  Testing all candidates against Strathfield, NSW 2135          ║")
    print("╚══════════════════════════════════════════════════════════════════╝")

    all_results = {}

    # A) Agent Scrapers
    all_results["agents"] = run_benchmark(
        "CATEGORY A: Domain.com.au AGENT Scrapers",
        AGENT_SCRAPERS,
        analyze_agent_results
    )

    # B) Domain Property Scrapers
    all_results["domain_property"] = run_benchmark(
        "CATEGORY B: Domain.com.au PROPERTY Scrapers",
        PROPERTY_SCRAPERS,
        analyze_property_results
    )

    # C) REA Property Scrapers
    all_results["rea_property"] = run_benchmark(
        "CATEGORY C: realestate.com.au Scrapers",
        REA_SCRAPERS,
        analyze_property_results
    )

    # Save full results to JSON
    output_path = "/tmp/apify_benchmark_results.json"
    with open(output_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\n{'='*70}")
    print(f"  FINAL SUMMARY")
    print(f"{'='*70}")
    print(f"\n  Full results saved to: {output_path}")
    print(f"\n  RECOMMENDED STACK (based on scores):")

    for cat, label in [("agents", "Agent Intelligence"), ("domain_property", "Domain Listings"), ("rea_property", "REA Listings")]:
        winners = [r for r in all_results[cat] if r["status"] == "OK"]
        if winners:
            w = winners[0]
            print(f"    {label:25s} → {w['label']} (Score: {w['score']}/100, {w['count']} results)")
        else:
            print(f"    {label:25s} → ALL FAILED — check inputs/tokens")

    print(f"\n  Run this after creating your Apify account:")
    print(f"  APIFY_TOKEN=apify_api_xxxxx python3 scripts/apify-actor-benchmark.py")
