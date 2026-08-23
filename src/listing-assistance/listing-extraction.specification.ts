import type { ListingExtractionField } from './listing-extraction.policy';

export const LISTING_EXTRACTION_SPECIFICATION_VERSION =
  'listing-extraction-semantics-v1';

export const listingExtractionSpecification: Record<
  ListingExtractionField,
  {
    meaning: string;
    germanTerms: readonly string[];
    normalization: string;
    doNotInterpret: readonly string[];
  }
> = {
  objectType: {
    meaning: 'Type of rental property.',
    germanTerms: ['Wohnung', 'Apartment', 'Haus', 'Zimmer', 'WG-Zimmer'],
    normalization: 'Map only unambiguous terms to the Renyqo enum.',
    doNotInterpret: ['contract type'],
  },
  city: {
    meaning: 'City where the property is located.',
    germanTerms: ['Stadt', 'Ort', 'in Berlin'],
    normalization: 'Preserve the city identity and casing.',
    doNotInterpret: ['agency or contact city'],
  },
  zip: {
    meaning: 'German postal code of the property.',
    germanTerms: ['PLZ', 'Postleitzahl'],
    normalization: 'Keep as a string, including leading zeroes.',
    doNotInterpret: ['phone number', 'listing number'],
  },
  street: {
    meaning: 'Property street and house number.',
    germanTerms: ['Straße', 'Str.', 'Hausnummer', 'Adresse'],
    normalization: 'Keep street and number when explicitly present.',
    doNotInterpret: ['agency address', 'owner address'],
  },
  district: {
    meaning: 'Neighbourhood or district of the property.',
    germanTerms: ['Stadtteil', 'Bezirk', 'Viertel'],
    normalization: 'Preserve the named locality.',
    doNotInterpret: ['city or federal state'],
  },
  livingArea: {
    meaning: 'Residential living area in square metres.',
    germanTerms: [
      'Wohnfläche',
      'Wohnraumfläche',
      'm²',
      'm2',
      'qm',
      'Quadratmeter',
      'Fläche',
    ],
    normalization:
      'Convert decimal comma and explicit square-metre units only.',
    doNotInterpret: [
      'Grundstücksfläche',
      'Nutzfläche',
      'Balkonfläche',
      'Kellerfläche',
    ],
  },
  rooms: {
    meaning: 'Total number of rooms.',
    germanTerms: ['Zimmer', 'Räume', '2,5-Zimmer'],
    normalization:
      'Convert explicit decimal comma to a number and preserve fractions.',
    doNotInterpret: ['bedrooms', 'bathrooms', 'occupancy'],
  },
  bedrooms: {
    meaning: 'Number of separate bedrooms.',
    germanTerms: ['Schlafzimmer', 'Schlafräume'],
    normalization: 'Return an integer only when explicitly stated.',
    doNotInterpret: ['total rooms'],
  },
  coldRent: {
    meaning: 'Monthly rent excluding additional costs.',
    germanTerms: ['Kaltmiete', 'Nettokaltmiete', 'Miete kalt', 'Grundmiete'],
    normalization: 'Convert German currency and decimal notation.',
    doNotInterpret: ['Warmmiete', 'Gesamtmiete', 'Kaution'],
  },
  additionalCosts: {
    meaning: 'Monthly additional operating costs.',
    germanTerms: ['Nebenkosten', 'Betriebskosten', 'NK'],
    normalization: 'Convert explicit German currency notation.',
    doNotInterpret: ['total rent', 'deposit'],
  },
  depositMonths: {
    meaning: 'Explicit number of cold-rent months for the deposit.',
    germanTerms: ['Monatskaltmieten', 'Kaution in Höhe von drei Monatsmieten'],
    normalization: 'Return only an explicitly stated integer from 1 to 3.',
    doNotInterpret: ['monetary deposit alone', 'system default'],
  },
  availableFrom: {
    meaning: 'Date when the property becomes available.',
    germanTerms: [
      'frei ab',
      'verfügbar ab',
      'bezugsfrei ab',
      'Einzug ab',
      'verfügbar zum',
      'ab sofort',
      'sofort',
      'sofort verfügbar',
      'verfügbar ab heute',
    ],
    normalization:
      'Use the supplied Europe/Berlin backend date for immediate availability. Convert unambiguous DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY, and DDMM.YYYY dates to ISO. If day and month can be swapped, return null and mark availableFrom uncertain.',
    doNotInterpret: ['publication date', 'viewing date', 'month without year'],
  },
  title: {
    meaning: 'Explicit listing title.',
    germanTerms: ['Titel', 'Überschrift'],
    normalization:
      'Preserve explicit title text without generating or rewriting it.',
    doNotInterpret: ['inferred title', 'marketing copy'],
  },
  shortDescription: {
    meaning: 'Explicit property description.',
    germanTerms: ['Beschreibung', 'Objektbeschreibung'],
    normalization: 'Preserve supported source text only.',
    doNotInterpret: ['generated summary', 'marketing copy'],
  },
  minimumHouseholdNetIncome: {
    meaning: 'Explicit minimum monthly net household income.',
    germanTerms: [
      'Mindestnettoeinkommen',
      'Haushaltsnettoeinkommen',
      'Nettoeinkommen mindestens',
    ],
    normalization: 'Convert explicit German currency notation.',
    doNotInterpret: ['gross income', 'annual income', 'rent'],
  },
  schufaRequired: {
    meaning: 'Whether a SCHUFA document is explicitly required.',
    germanTerms: ['Schufa erforderlich', 'Schufa-Auskunft notwendig'],
    normalization: 'Return false only for explicit negation.',
    doNotInterpret: ['absence of a SCHUFA statement'],
  },
  incomeProofRequired: {
    meaning: 'Whether income proof is explicitly required.',
    germanTerms: [
      'Einkommensnachweis',
      'Gehaltsnachweise',
      'Einkommen nachweisen',
    ],
    normalization: 'Return false only for explicit negation.',
    doNotInterpret: ['informal recommendation'],
  },
  suitableForPeopleCount: {
    meaning: 'Explicit number of people the property is suitable for.',
    germanTerms: ['geeignet für', 'maximal ... Personen', 'Belegung'],
    normalization: 'Return only an explicit integer.',
    doNotInterpret: ['number inferred from rooms or area'],
  },
  petsPolicy: {
    meaning: 'Explicit policy for pets.',
    germanTerms: [
      'Haustiere erlaubt',
      'nach Vereinbarung',
      'Haustiere nicht erlaubt',
    ],
    normalization: 'Map only unambiguous statements to the Renyqo enum.',
    doNotInterpret: ['policy for one species generalized to all pets'],
  },
  smokingPolicy: {
    meaning: 'Explicit smoking policy.',
    germanTerms: [
      'Rauchen erlaubt',
      'nach Vereinbarung',
      'Nichtraucher bevorzugt',
    ],
    normalization: 'Map only unambiguous statements to the Renyqo enum.',
    doNotInterpret: ['ambiguous Nichtraucher wording'],
  },
};

export const listingExtractionSpecificationPrompt = [
  'Field-level extraction specification:',
  ...Object.entries(listingExtractionSpecification).map(([field, spec]) =>
    [
      `${field}: ${spec.meaning}`,
      `German terms: ${spec.germanTerms.join(', ')}`,
      `Normalization: ${spec.normalization}`,
      `Do not interpret as: ${spec.doNotInterpret.join(', ')}`,
    ].join('\n'),
  ),
  'Follow this specification strictly when extracting values.',
].join('\n\n');
