import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authConfiguration } from '../../../../../../server/auth.js';
import {
  cancelEnableBankingCallback,
  completeEnableBankingCallback,
} from '../../../../../../server/enable-banking.js';

function safeResultUrl(result: string): URL {
  const url = new URL('/debug', authConfiguration().appOrigin);
  url.searchParams.set('open_banking', result);
  return url;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const states = request.nextUrl.searchParams.getAll('state');
  const codes = request.nextUrl.searchParams.getAll('code');
  const errors = request.nextUrl.searchParams.getAll('error');
  if (states.length !== 1 || (codes.length === 1) === (errors.length === 1)) {
    return NextResponse.redirect(safeResultUrl('failed'), 303);
  }
  try {
    if (errors.length === 1) {
      await cancelEnableBankingCallback(states[0]!);
      return NextResponse.redirect(safeResultUrl('cancelled'), 303);
    }
    await completeEnableBankingCallback(states[0]!, codes[0]!);
    return NextResponse.redirect(safeResultUrl('connected'), 303);
  } catch {
    return NextResponse.redirect(safeResultUrl('failed'), 303);
  }
}
