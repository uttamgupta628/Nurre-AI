'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useUser } from './client'

const ADMIN_CACHE_KEY = 'nuree-is-admin'

/** Call on sign-out so the next account in this tab doesn't inherit the hint. */
export function clearAdminStatusCache() {
  try {
    sessionStorage.removeItem(ADMIN_CACHE_KEY)
  } catch {
    // storage unavailable - nothing to clear
  }
}

export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const { user, loading: userLoading } = useUser()
  const userId = user?.id ?? null

  // Monotonic id so a slow, outdated response can never overwrite a newer one.
  const requestRef = useRef(0)
  // undefined = the mount-time check hasn't been attributed to a user yet.
  const lastCheckedIdRef = useRef<string | null | undefined>(undefined)

  const checkAdmin = useCallback(async () => {
    const requestId = ++requestRef.current

    try {
      // /api/admin/check-access validates the session from the cookie and looks
      // up the user server-side, so it doesn't need the client user store.
      const response = await fetch('/api/admin/check-access', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
      })

      if (requestId !== requestRef.current) return

      setIsAdmin(response.ok)
      try {
        sessionStorage.setItem(ADMIN_CACHE_KEY, response.ok ? 'true' : 'false')
      } catch {
        // storage unavailable - the cache is only a speed-up
      }
    } catch (error) {
      console.error('Error checking admin status:', error)
      if (requestId === requestRef.current) {
        setIsAdmin(false)
      }
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false)
      }
    }
  }, [])

  // 1. Show the last known answer immediately (it is re-verified right below),
  //    and start the real check straight away instead of waiting for the user
  //    store to finish its own network calls.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(ADMIN_CACHE_KEY) === 'true') {
        setIsAdmin(true)
      }
    } catch {
      // ignore
    }

    checkAdmin()
  }, [checkAdmin])

  // 2. React to auth changes once the user store has resolved.
  useEffect(() => {
    if (userLoading) return

    // Signed out: invalidate anything in flight and reset.
    if (!userId) {
      requestRef.current++
      lastCheckedIdRef.current = null
      setIsAdmin(false)
      setLoading(false)
      clearAdminStatusCache()
      return
    }

    // First time the user is known: the mount-time check already covers them.
    if (lastCheckedIdRef.current === undefined) {
      lastCheckedIdRef.current = userId
      return
    }

    // Signed in after being signed out, or switched accounts: check again.
    if (lastCheckedIdRef.current !== userId) {
      lastCheckedIdRef.current = userId
      setLoading(true)
      checkAdmin()
    }
  }, [userId, userLoading, checkAdmin])

  return { isAdmin, loading }
}