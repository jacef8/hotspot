// Valuation, debt service calculation, and scoring engine for deals

/**
 * Calculates debt service, valuation multiples, monthly cash flow, and assigns a verdict.
 */
function scoreListing(deal, geoInfo) {
  const price = deal.price || 0;
  const isOperatingBusiness = deal.assetType === 'Car Wash' || deal.assetType === 'General Business / Real Estate';
  const isCarWash = deal.assetType === 'Car Wash';

  // 1. Debt Service Assumptions (75% LTV, 7.5% interest, 25yr amort)
  const ltv = 0.75;
  const loanAmount = price * ltv;
  const downPayment = price * (1 - ltv);
  const annualInterestRate = 0.075;
  const monthlyRate = annualInterestRate / 12;
  const totalPayments = 25 * 12;

  let monthlyDebtService = 0;
  if (price > 0) {
    monthlyDebtService = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, totalPayments)) /
                         (Math.pow(1 + monthlyRate, totalPayments) - 1);
  }
  const annualDebtService = monthlyDebtService * 12;

  // 2. Income & Valuation Analysis
  let calculatedNOI = deal.noi || 0;
  let sde = deal.sde || 0;
  let capRate = deal.capRate || null;

  // Estimate NOI if Cap Rate & Price provided
  if (!calculatedNOI && capRate && price > 0) {
    calculatedNOI = price * (capRate / 100);
  }

  // Estimate Cap Rate if NOI & Price provided
  if (!capRate && calculatedNOI > 0 && price > 0) {
    capRate = (calculatedNOI / price) * 100;
  }

  // Car Wash / Business SDE Multiple logic
  let sdeMultiple = null;
  if (isOperatingBusiness && price > 0) {
    if (sde > 0) {
      sdeMultiple = price / sde;
    } else if (calculatedNOI > 0) {
      // Approximate SDE from NOI for business
      sdeMultiple = price / calculatedNOI;
      sde = calculatedNOI;
    }
  }

  // Monthly Net Cash Flow after Debt
  let monthlyNetCashFlow = 0;
  if (calculatedNOI > 0) {
    monthlyNetCashFlow = Math.round((calculatedNOI - annualDebtService) / 12);
  }

  // 3. Verdict Decision Rules
  let verdict = 'Watch';
  let scoreNotes = [];

  // Region Check
  if (!geoInfo.inRegion) {
    verdict = 'Pass';
    scoreNotes.push(`Out of Region (${geoInfo.distanceMiles} miles from Bristol, FL). High management friction for distance.`);
  } else {
    // In-Region Logic
    if (isCarWash) {
      if (sdeMultiple && sdeMultiple <= 3.2) {
        verdict = 'Pursue';
        scoreNotes.push(`Priced at ${sdeMultiple.toFixed(1)}x SDE owner earnings (within 2-3x target range).`);
      } else if (capRate && capRate >= 11.0) {
        verdict = 'Pursue';
        scoreNotes.push(`Strong ${capRate.toFixed(1)}% Cap Rate in target Panhandle radius (${geoInfo.distanceMiles} mi from Bristol).`);
      } else {
        verdict = 'Watch';
        scoreNotes.push(`Car wash evaluation requires verifiable SDE financial audit & land stack valuation.`);
      }
    } else {
      // Real Estate (Multifamily, MHP, Storage)
      if (monthlyNetCashFlow > 1000 || (capRate && capRate >= 8.5)) {
        verdict = 'Pursue';
        scoreNotes.push(`Positive cash flow (~$${monthlyNetCashFlow.toLocaleString()}/mo after 75% LTV debt service).`);
      } else if (monthlyNetCashFlow < 0) {
        verdict = 'Pass';
        scoreNotes.push(`Negative cash flow after debt service (-$${Math.abs(monthlyNetCashFlow).toLocaleString()}/mo).`);
      } else {
        verdict = 'Watch';
        scoreNotes.push(`Acceptable yield (${capRate ? capRate.toFixed(1) + '%' : 'unpriced'}). Requires full rent-roll audit.`);
      }
    }
  }

  // Operating Business Warning Tag
  let valuationWarning = null;
  if (isCarWash) {
    valuationWarning = "A car wash is not a cap rate. Operating businesses trade on 2–3x owner earnings (SDE), not a pure cap rate. Land and building value stack on top of the business multiple.";
  }

  return {
    priceFormatted: price ? `$${price.toLocaleString()}` : 'Unpriced',
    downPaymentFormatted: downPayment ? `$${Math.round(downPayment).toLocaleString()}` : 'N/A',
    monthlyDebtServiceFormatted: monthlyDebtService ? `$${Math.round(monthlyDebtService).toLocaleString()}` : 'N/A',
    noiFormatted: calculatedNOI ? `$${Math.round(calculatedNOI).toLocaleString()}` : (sde ? `$${Math.round(sde).toLocaleString()} (SDE)` : 'TBD'),
    capRateFormatted: capRate ? `${capRate.toFixed(1)}%` : 'N/A',
    sdeMultipleFormatted: sdeMultiple ? `${sdeMultiple.toFixed(1)}x SDE` : 'N/A',
    monthlyNetCashFlow: monthlyNetCashFlow,
    monthlyNetCashFlowFormatted: monthlyNetCashFlow ? `${monthlyNetCashFlow >= 0 ? '+' : ''}$${monthlyNetCashFlow.toLocaleString()}/mo` : 'TBD',
    verdict: verdict,
    scoreNotes: scoreNotes,
    valuationWarning: valuationWarning
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreListing };
}
