// Multi-source email digest and text parser for Crexi, LoopNet, BizBuySell, and Ten-X alerts

/**
 * Parses raw text from email alerts into structured listing objects.
 * Handles single listings, multi-listing digest blocks, and missing prices/links.
 */
function parseDealAlerts(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  const text = rawText.replace(/\r\n/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const listings = [];

  // Break text into logical blocks (double line breaks or Crexi property card delimiters)
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim().length > 10);

  blocks.forEach((block, idx) => {
    const listing = parseSingleBlock(block, idx);
    if (listing) {
      listings.push(listing);
    }
  });

  // Deduplicate listings based on exact title + city + price combination
  return deduplicateListings(listings);
}

function parseSingleBlock(block, blockIndex) {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let title = lines[0];
  let price = extractPrice(block);
  let capRate = extractCapRate(block);
  let noi = extractNOI(block);
  let sde = extractSDE(block);
  let url = extractURL(block);
  let locationStr = extractLocation(block);
  let assetType = classifyAssetType(block);

  // If title looks like a price or header, use line 2 if available
  if (title.startsWith('$') || title.toLowerCase().includes('view property') || title.toLowerCase().includes('crexi')) {
    if (lines.length > 1) title = lines[1];
  }

  // Crexi Digest specific parsing (handles Crexi IDs like 1820918)
  const crexiIdMatch = block.match(/crexi\.com\/properties\/(\d+)/i) || block.match(/Listing (\d+)/i);
  let crexiId = crexiIdMatch ? crexiIdMatch[1] : null;

  if (crexiId && !url) {
    url = `https://www.crexi.com/properties/${crexiId}`;
  }

  // Create unique deduplication signature
  const rawId = crexiId || `parsed-${blockIndex}-${slugify(title)}-${slugify(locationStr)}`;

  return {
    id: rawId,
    title: title.substring(0, 100),
    locationRaw: locationStr,
    price: price,
    capRate: capRate,
    noi: noi,
    sde: sde,
    assetType: assetType,
    url: url || '#',
    rawText: block
  };
}

// Extraction Utilities

function extractPrice(text) {
  // Matches $1,250,000 or $425k or $299,000
  const matchK = text.match(/\$\s*([\d,.]+)\s*k\b/i);
  if (matchK) {
    return Math.round(parseFloat(matchK[1].replace(/,/g, '')) * 1000);
  }
  const matchM = text.match(/\$\s*([\d,.]+)\s*m\b/i);
  if (matchM) {
    return Math.round(parseFloat(matchM[1].replace(/,/g, '')) * 1000000);
  }
  const matchFull = text.match(/\$\s*([\d,]{4,12})/);
  if (matchFull) {
    return parseInt(matchFull[1].replace(/,/g, ''), 10);
  }
  return null;
}

function extractCapRate(text) {
  const match = text.match(/([\d.]+)%\s*cap\b/i) || text.match(/cap\s*(?:rate)?\s*:?\s*([\d.]+)%/i);
  return match ? parseFloat(match[1]) : null;
}

function extractNOI(text) {
  const match = text.match(/noi\s*:?\s*\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (match) {
    let val = parseFloat(match[1].replace(/,/g, ''));
    if (match[2] && match[2].toLowerCase() === 'k') val *= 1000;
    if (match[2] && match[2].toLowerCase() === 'm') val *= 1000000;
    return val;
  }
  return null;
}

function extractSDE(text) {
  const match = text.match(/(?:sde|cash flow|owner earnings)\s*:?\s*\$?\s*([\d,.]+)\s*(k|m)?/i);
  if (match) {
    let val = parseFloat(match[1].replace(/,/g, ''));
    if (match[2] && match[2].toLowerCase() === 'k') val *= 1000;
    if (match[2] && match[2].toLowerCase() === 'm') val *= 1000000;
    return val;
  }
  return null;
}

function extractURL(text) {
  const match = text.match(/https?:\/\/[^\s"'>]+/i);
  return match ? match[0] : null;
}

function extractLocation(text) {
  // Looks for "City, ST" or common city names
  const match = text.match(/([A-Z][a-z\s.]+),\s*(FL|GA|AL|TN|NC|SC|MS|TX|OH|MI)/);
  if (match) return `${match[1].trim()}, ${match[2]}`;
  
  const towns = ['Bristol', 'Blountstown', 'Marianna', 'DeFuniak Springs', 'DeFuniak', 'Port St. Joe', 'Panama City', 'Bonifay', 'Chipley', 'Tallahassee', 'Monroe', 'Bainbridge', 'Quincy', 'Apalachicola'];
  for (const t of towns) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(text)) return t;
  }
  return 'Panhandle, FL';
}

function classifyAssetType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('car wash') || lower.includes('carwash') || lower.includes('in-bay') || lower.includes('touch-free')) {
    return 'Car Wash';
  }
  if (lower.includes('trailer park') || lower.includes('mobile home') || lower.includes('mhp') || lower.includes('manufactured housing')) {
    return 'Mobile Home Park';
  }
  if (lower.includes('apartment') || lower.includes('multifamily') || lower.includes('multi-family') || lower.includes('unit') || lower.includes('duplex')) {
    return 'Multifamily';
  }
  if (lower.includes('storage') || lower.includes('self-storage') || lower.includes('mini storage')) {
    return 'Self Storage';
  }
  if (lower.includes('vacation rental') || lower.includes('cottage') || lower.includes('hospitality') || lower.includes('hotel') || lower.includes('resort')) {
    return 'Vacation Rental / Hospitality';
  }
  if (lower.includes('retail') || lower.includes('office') || lower.includes('industrial') || lower.includes('commercial')) {
    return 'Commercial / Retail';
  }
  return 'General Business / Real Estate';
}

function deduplicateListings(listings) {
  const seen = new Map();
  const result = [];

  for (const item of listings) {
    // Dedupe key based on normalized title + location + price
    const key = `${slugify(item.title)}-${slugify(item.locationRaw)}-${item.price || 'noprice'}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(item);
    }
  }

  return result;
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDealAlerts, parseSingleBlock, classifyAssetType };
}
