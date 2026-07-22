/* railbound-logic.js — backward-compatible re-export of the canonical Rule Layer.
 * All game rules, simulation, and reachability live in railbound-rules.js.
 * Import from here or from railbound-rules.js — both work identically.
 */
export {
  TRACKS, T_META, T_SWITCH_PAIRS, OPPOSITE, DELTA, ALL_DIRS, BASIC_TRACKS, T_TRACKS, TRACK_NAMES, pk, exitPort,
  TRACKS_BY_ENTRY, BASIC_BY_ENTRY, TRACKS_BY_EXIT, TUNNEL_COLORS, BARRIER_COLORS, buildTunnelMap,
  buildTSwitchMap, buildAutoSwitchMap, effectiveTSwitchTrack, effectiveAutoSwitchTrack, effectiveTrackAt, tswitchTrackVariants,
  occupiedBarrierColors,
  buildPlatformState, platformPickupForCar, carNeedsPassengers, allPlatformsServed,
  isZeroCar, requiredOrder, zeroSafetySteps, zeroSafetyLookahead,
  simulate, forwardReachable, backwardReachable, filterBlanks,
  blockedCellsForCar, carWaypoints, minRemainingDist,
  puzzleHasDynamicState,
} from "./railbound-rules.js";
