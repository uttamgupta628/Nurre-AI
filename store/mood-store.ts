import { create } from 'zustand'
import { createClient } from '@/lib/supabase/client'
import { requestCache } from '@/lib/cache/request-cache'
import { useUserStore } from './user-store'

export interface MoodEntry {
  id?: string
  user_id?: string
  mood?: 'terrible' | 'bad' | 'okay' | 'good' | 'excellent'
  energy?: number  // 1-10
  focus?: number   // 1-10
  note?: string
  created_at?: string
  source?: 'user' | 'ai_detected' | 'ai_suggested' | 'ai_confirmed'
  ai_confidence?: number
}

interface MoodStore {
  currentMood: MoodEntry | null
  recentMoods: MoodEntry[]
  isLoading: boolean
  error: string | null
  
  // Actions
  setCurrentMood: (mood: MoodEntry) => void
  fetchRecentMoods: () => Promise<void>
  addMoodEntry: (mood: Omit<MoodEntry, 'id' | 'user_id' | 'created_at'>, context?: string) => Promise<void>
  updateMoodFromAI: (mood: MoodEntry) => void
  clearError: () => void
  
  // Tool-friendly method for native tool calling
  logMoodFromTool: (params: {
    mood: 'terrible' | 'bad' | 'okay' | 'good' | 'excellent'
    energy: number
    focus?: number
    notes?: string
  }) => Promise<{ entryId: string; success: boolean; error?: string }>
}

export const useMoodStore = create<MoodStore>((set, get) => ({
  currentMood: null,
  recentMoods: [],
  isLoading: false,
  error: null,
  
  setCurrentMood: (mood) => set({ currentMood: mood }),
  
  fetchRecentMoods: async () => {
    set({ isLoading: true, error: null })
    try {
      const supabase = createClient()
      const user = useUserStore.getState().user

      if (!user) {
        throw new Error('No authenticated user')
      }
      
      // Check cache first
      const cacheKey = `moods-${user.id}`
      const cached = requestCache.get<MoodEntry[]>(cacheKey)
      
      if (cached) {
        set({ recentMoods: cached, currentMood: cached[0] || null, isLoading: false })
        return
      }
      
      const { data, error } = await supabase
        .from('mood_entries')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10)
      
      if (error) throw error
      
      // Cache for 2 minutes
      if (data) {
        requestCache.set(cacheKey, data, 120000)
      }
      
      set({ 
        recentMoods: data || [],
        currentMood: data?.[0] || null,
        isLoading: false 
      })
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to fetch moods',
        isLoading: false 
      })
    }
  },
  
  addMoodEntry: async (mood, context) => {
    set({ isLoading: true, error: null })

    try {
      const supabase = createClient()
      const user = useUserStore.getState().user

      if (!user) {
        throw new Error('No authenticated user')
      }

      // Invalidate cache when adding mood
      requestCache.delete(`moods-${user.id}`)
      
      // Use new schema with separate columns
      const moodData = {
        user_id: user.id,
        mood: mood.mood || 'okay',
        energy: mood.energy || 5,
        focus: mood.focus || 5,
        note: mood.note,
        source: mood.source || 'user',
        ai_confidence: mood.ai_confidence,
        // Add context metadata if provided
        ...(context && {
          metadata: {
            context, // 'welcome', 'routine', etc.
            time_of_day: new Date().getHours() < 12 ? 'morning' : 
                        new Date().getHours() < 17 ? 'afternoon' : 
                        new Date().getHours() < 21 ? 'evening' : 'night'
          }
        })
      }
      
      const { data, error } = await supabase
        .from('mood_entries')
        .insert(moodData)
        .select()
        .single()
      
      if (error) throw error
      
      set(state => ({
        currentMood: data,
        recentMoods: [data, ...state.recentMoods].slice(0, 10),
        isLoading: false
      }))
      
      // Track mood change event
      await supabase.from('events').insert({
        user_id: user.id,
        type: 'mood_update',
        data: { 
          mood: data.mood,
          energy: data.energy,
          focus: data.focus,
          source: data.source
        }
      })
    } catch (error) {
      set({ 
        error: error instanceof Error ? error.message : 'Failed to add mood',
        isLoading: false 
      })
    }
  },
  
  updateMoodFromAI: (mood) => {
    // This is called when AI detects a mood but doesn't immediately save it
    // It can be used to show the suggestion to the user
    set({ currentMood: mood })
  },
  
  clearError: () => set({ error: null }),
  
  // Tool-friendly method for native tool calling
  logMoodFromTool: async (params) => {
    try {
      const supabase = createClient()

      // Resolve the user robustly. The client user store can still be empty
      // right after page load / on a fresh voice session, which used to make
      // the AI answer "I can't log that". Fall back to the Supabase session.
      let userId = useUserStore.getState().user?.id
      if (!userId) {
        const { data: { user: authUser } } = await supabase.auth.getUser()
        userId = authUser?.id
      }
      if (!userId) {
        return { entryId: '', success: false, error: 'Please sign in to log your mood.' }
      }

      const energy = Math.min(10, Math.max(1, Math.round(Number(params.energy)) || 5))
      const baseRow = {
        user_id: userId,
        mood: params.mood,
        energy,
        focus: params.focus || 5,
        note: params.notes,
      }

      // Try with source first; if the column/constraint rejects it, retry
      // without so a schema difference can't block the log.
      let { data, error } = await supabase
        .from('mood_entries')
        .insert({ ...baseRow, source: 'user' as const })
        .select()
        .single()

      if (error) {
        console.warn('Mood insert with source failed, retrying without it:', error.message)
        ;({ data, error } = await supabase
          .from('mood_entries')
          .insert(baseRow)
          .select()
          .single())
      }

      if (error || !data) {
        console.error('Tool mood logging failed:', error)
        return { entryId: '', success: false, error: error?.message || 'Failed to log mood' }
      }

      requestCache.delete(`moods-${userId}`)
      set(state => ({
        currentMood: data,
        recentMoods: [data, ...state.recentMoods].slice(0, 10)
      }))

      // Event tracking is best-effort — never fail the log because of it
      try {
        await supabase.from('events').insert({
          user_id: userId,
          type: 'mood_update',
          data: { mood: data.mood, energy: data.energy, focus: data.focus, source: 'tool' }
        })
      } catch (e) {
        console.warn('mood_update event failed:', e)
      }

      return { entryId: data.id, success: true }
    } catch (error) {
      console.error('Tool mood logging failed:', error)
      return {
        entryId: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
}))