import type { NyRange } from './ny';

/** The hierarchical DocumentSymbol contract advertised by Ny's stdio language server. */
export interface NyDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: NyRange;
  selectionRange: NyRange;
  children?: NyDocumentSymbol[];
}
