// ─── NolTech Arbitrage Deal Analyzer Service ─────────────────────────────────
// Calls the Claude API to perform three-path arbitrage analysis on electronics
// listings. Shares the callClaude / extractJSON helpers with ai.js to avoid
// code drift on API config (model name, headers, etc.).

import { callClaude, extractJSON } from './ai';

// ─── System Prompt ────────────────────────────────────────────────────────────

const ANALYZE_SYSTEM = `You are an expert electronics reseller with deep component-level knowledge. You do arbitrage analysis for a reseller in Los Angeles who specializes in business laptops, desktops, and GPUs. The reseller's primary channel is eBay, with secondary sales on Mercari and Facebook Marketplace.

Return ONLY valid JSON — no markdown, no explanation, no code fences. Start your response with { and end with }.

Fee and cost calculation rules (apply these exactly):
- eBay fee = 9.35% of (salePrice + shippingOut). Round to 2 decimal places.
- netRevenue = salePrice - ebayFee - shippingOut
- profit = netRevenue - askingPrice
- roi = (profit / askingPrice) * 100. Round to 1 decimal place.
- Shipping estimates (use these exact values unless you have strong reason otherwise):
    laptop=$12, desktop=$18, GPU=$12, small parts=$5, phone=$6, tablet=$8, monitor=$20
- Part-out shipping per part: screen=$10, RAM=$5, SSD=$5, HDD=$6, battery=$8, keyboard=$8, charger=$6, GPU=$12, CPU=$6, motherboard=$12, other=$5
- Labor cost: laptop=2hrs*$15=$30, desktop=1hr*$15=$15, phone=1.5hr*$15=$22.50, GPU=0hr=$0
- For "unknown" condition: value at "workingMid * 0.65" for resell whole; use partsBreakdown totals for part-out
- For "broken" or "poor" condition: use brokenMid for resell whole valuation; use partsBreakdown totals for part-out
- viable = true only if profit > 0 AND roi > 15

Your response must match this exact JSON schema:
{
  "product": {
    "brand": "string",
    "model": "string",
    "fullName": "string — brand + model + key specs in one readable string",
    "category": "laptop|desktop|gpu|phone|tablet|monitor|other",
    "specs": "string — CPU, RAM, storage, screen, GPU — whatever is known from the description",
    "confidence": "high|medium|low",
    "notes": "string — anything notable about this product's resale market, price trends, variants"
  },
  "unitValuation": {
    "workingMid": 0,
    "workingRange": [0, 0],
    "brokenMid": 0,
    "brokenRange": [0, 0],
    "notes": "string — key factors affecting valuation, model variants, condition impact"
  },
  "partsBreakdown": [
    {
      "component": "string — part name",
      "value": 0,
      "demand": "high|medium|low",
      "notes": "string — optional context"
    }
  ],
  "scenarios": {
    "resellWhole": {
      "salePrice": 0,
      "ebayFee": 0,
      "shippingOut": 0,
      "netRevenue": 0,
      "profit": 0,
      "roi": 0,
      "viable": true
    },
    "partOut": {
      "totalPartsValue": 0,
      "ebayFees": 0,
      "shippingCosts": 0,
      "laborHours": 0,
      "laborCost": 0,
      "netRevenue": 0,
      "profit": 0,
      "roi": 0,
      "viable": true
    }
  },
  "recommendation": "resell_whole|part_out|pass",
  "reasoning": "string — 2-3 sentences explaining why this recommendation maximizes ROI given the asking price, condition, and market",
  "risks": ["string — array of specific risks for this deal"],
  "redFlags": ["string — array of red flags that could kill the deal or indicate fraud/issues"]
}`;

// ─── Format component DB for prompt context ────────────────────────────────────

function formatComponentContext(componentDB) {
  if (!componentDB || componentDB.length === 0) return 'No component reference data available.';

  const entries = componentDB.slice(0, 50);
  const lines = entries.map((c) => {
    const cat = c.category.replace('_', ' ').toUpperCase();
    return `[${cat}] ${c.name}: $${c.valueLow}–$${c.valueMid}–$${c.valueHigh} (demand: ${c.demand})${c.notes ? ' — ' + c.notes : ''}`;
  });

  return `COMPONENT REFERENCE DATABASE (eBay sold prices: low/mid/high):\n${lines.join('\n')}`;
}

// ─── Main Export ───────────────────────────────────────────────────────────────

/**
 * Analyze an arbitrage deal using Claude.
 *
 * @param {string}   apiKey       - Anthropic API key
 * @param {string}   description  - Raw listing text, title, or description pasted by user
 * @param {number}   askingPrice  - The price the seller is asking
 * @param {string}   condition    - 'working' | 'unknown' | 'broken'
 * @param {Array}    componentDB  - Array of component objects from storage/seed data
 * @returns {Promise<Object>}     - Parsed analysis result matching the schema above
 */
export async function analyzeDeal(apiKey, description, askingPrice, condition, componentDB) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('No API key configured. Go to Settings and add your Anthropic API key.');
  }
  if (!description || !description.trim()) {
    throw new Error('Please paste a listing description or title to analyze.');
  }
  if (!askingPrice || isNaN(askingPrice) || askingPrice <= 0) {
    throw new Error('Please enter a valid asking price greater than $0.');
  }

  const componentContext = formatComponentContext(componentDB);

  const userMessage = `Analyze this electronics listing for arbitrage potential:

LISTING DESCRIPTION:
${description.trim()}

ASKING PRICE: $${Number(askingPrice).toFixed(2)}
CONDITION: ${condition}

${componentContext}

Apply all fee and cost calculation rules from your system prompt exactly. Calculate every number precisely — do not approximate.`;

  let rawText;
  try {
    rawText = await callClaude(apiKey, ANALYZE_SYSTEM, userMessage, 2500);
  } catch (err) {
    throw new Error(`Claude API error: ${err.message}`);
  }

  let result;
  try {
    result = extractJSON(rawText);
  } catch (err) {
    throw new Error(`Failed to parse AI response as JSON. ${err.message}`);
  }

  // Validate top-level shape
  if (!result.product || !result.scenarios || !result.recommendation) {
    throw new Error('AI response was missing required fields. Please try again.');
  }

  // Attach metadata
  result._meta = {
    askingPrice: Number(askingPrice),
    condition,
    analyzedAt: new Date().toISOString(),
  };

  return result;
}
