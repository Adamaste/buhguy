export const TBANK_ANDROID_PROVIDER = 'com.idamob.tinkoff.android';

export function hasAutomaticMatchedPurchaseAccountProof(bank) {
  if (!bank || typeof bank !== 'object') return false;
  if (bank.provider === TBANK_ANDROID_PROVIDER) {
    return bank.tbankCardSpecificAccountProofVerified === true;
  }
  return bank.sourceProviderBindingVerified === true;
}
