'use client'

import { HydrationBoundary, QueryClientProvider } from '@tanstack/react-query'
import { ENV } from '@shared/static'
import dynamic from 'next/dynamic'

import { IProvidersProps } from '../types/IProvidersProps'

import { useProviders } from './useProviders'

const ReactQueryDevtools = dynamic(
  () =>
    import('@tanstack/react-query-devtools').then(
      (mod) => mod.ReactQueryDevtools,
    ),
  { ssr: false },
)

const Providers = (props: IProvidersProps) => {
  const { queryClient, children, dehydratedState } = useProviders(props)

  return (
    <QueryClientProvider client={queryClient}>
      <HydrationBoundary state={dehydratedState}>
        {ENV.IS_DEVELOPMENT && <ReactQueryDevtools initialIsOpen={false} />}
        {children}
      </HydrationBoundary>
    </QueryClientProvider>
  )
}

export { Providers }
