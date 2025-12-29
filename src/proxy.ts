import { NextResponse } from 'next/server'

import type { NextRequest } from 'next/server'

const checkIsMobile = (request: NextRequest) => {
  const userAgent = request.headers.get('user-agent') ?? ''
  return /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent)
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
}

export const proxy = (request: NextRequest) => {
  const isMobile = checkIsMobile(request)

  const response = NextResponse.next()
  response.cookies.set('isMobile', isMobile ? '1' : '0', {
    path: '/',
    maxAge: 60 * 10,
  })

  return response
}
