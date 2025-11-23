/**
* GRIP Query Evaluator - Advanced query evaluation with hybrid optimization
* 
* Implements the core query evaluation system that determines which Taps should
* be active based on declarative query conditions. Features sophisticated
* optimization strategies including hybrid evaluation, caching, and efficient
* attribution algorithms.
* 
* Key Features:
* - Declarative query evaluation against Grip values
* - Hybrid evaluation strategy (precomputation + runtime)
* - Intelligent caching with complexity-based thresholds
* - Efficient attribution with disjoint set partitioning
* - Incremental binding management
* - Reactive evaluation on Grip changes
* 
* Architecture:
* - QueryEvaluator: Main evaluation engine with hybrid optimization
* - InvertedIndex: Efficient query-to-Grip mapping for reactive updates
* - AttributionUtility: Handles Tap attribution and conflict resolution
* - DisjointSetPartitioner: Groups queries by output Grips for efficient evaluation
* - TupleMap: Specialized caching for multi-dimensional query results
* 
* Performance Optimizations:
* - Precomputation for low-complexity query sets
* - Runtime evaluation for high-complexity sets
* - Caching with automatic invalidation
* - Incremental updates with minimal re-evaluation
* - Disjoint set partitioning for efficient attribution
*/

// ---[ Core GRIP Imports ]-------------------------------------------------------
// These types are imported from the existing GRIP engine's core files.
import { Grip } from "./grip";
import { Query, QueryConditions, QueryMatchScoreMap } from "./query";
import { Tap, TapFactory } from "./tap";
import { DisjointSetPartitioner, TupleMap, createCompositeKey } from "./query_utils";

// ---[ Evaluator-Specific Interfaces ]-------------------------------------------

/**
* Associates a Query with the Tap it activates and its base score.
* 
* Each binding represents a rule that says "when the query conditions are met,
* activate this Tap with this base score". The evaluator uses these bindings
* to determine which Taps should be active based on current Grip values.
* 
* @property id - Unique identifier for this binding
* @property query - The query conditions that must be satisfied
* @property tap - The Tap or TapFactory to activate when conditions are met
* @property baseScore - Base score for this binding (used in attribution)
*/
export interface QueryBinding {
id: string; // A unique identifier for this binding
query: Query;
tap: Tap | TapFactory;
baseScore: number;
}

/**
* Result of adding a new binding to the evaluator.
* 
* Provides information about which input Grips are newly introduced
* or no longer needed, enabling efficient subscription management.
* 
* @property newInputs - Grips that weren't tracked before this binding
* @property removedInputs - Grips no longer used by any query (from replaced bindings)
*/
export interface AddBindingResult {
/**
* A set of input Grips that were not known to the evaluator before this binding was added.
*/
newInputs: Set<Grip<any>>;
/**
* A set of input Grips that are no longer used by any query as a result of this binding update.
* This is only populated when an existing binding is replaced.
*/
removedInputs: Set<Grip<any>>;
}

/**
* Result of removing a binding from the evaluator.
* 
* Provides information about which input Grips are no longer needed,
* enabling cleanup of subscriptions and cached data.
* 
* @property removedInputs - Grips no longer used by any query
*/
export interface RemoveBindingResult {
/**
* A set of input Grips that are no longer used by any query after this binding was removed.
*/
removedInputs: Set<Grip<any>>;
}

/**
* Represents a matched query result, containing the tap and the calculated score.
* 
* When a query's conditions are satisfied by current Grip values, it produces
* a MatchedTap with the associated Tap and a calculated score based on the
* matching values and base score.
* 
* @property tap - The Tap or TapFactory that matched
* @property score - Calculated score based on matching values and base score
* @property bindingId - ID of the binding that produced this match
*/
export interface MatchedTap {
tap: Tap | TapFactory;
score: number;
bindingId: string;
}

/**
* The final result of the attribution process for a single Tap.
* 
* After all queries are evaluated, the attribution process determines
* which Taps should be active and which output Grips each Tap should provide.
* This represents the final attribution for one Tap.
* 
* @property producerTap - The Tap that was attributed outputs
* @property score - The score that won the attribution
* @property bindingId - ID of the binding that won
* @property attributedGrips - Set of output Grips this Tap should provide
*/
export interface TapAttribution {
producerTap: Tap | TapFactory;
score: number;
bindingId: string;
attributedGrips: Set<Grip<any>>;
}

/**
* Represents the change in attributions after an evaluation.
* 
* When Grip values change, the evaluator produces a delta that describes
* which Taps should be added or removed from the active set. This enables
* efficient incremental updates to the Tap graph.
* 
* @property added - New Tap attributions that should be activated
* @property removed - Previous Tap attributions that should be deactivated
*/
export interface EvaluationDelta {
added: Map<Tap | TapFactory, TapAttribution>;
removed: Map<Tap | TapFactory, TapAttribution>; // The old value that was removed
}

/**
* Formats an EvaluationDelta as a human-readable string for debugging.
* 
* @param delta - The evaluation delta to format
* @returns A formatted string showing added and removed attributions
*/
export function evaluationToString(delta: EvaluationDelta): string {
const formatAttribution = (attribution: TapAttribution): string => {
const tapId =
(attribution.producerTap as any).id ??
(attribution.producerTap as any).label ??
attribution.bindingId ??
"UnknownTap";
const grips = Array.from(attribution.attributedGrips)
.map((g) => g.key)
.join(", ");
return `  Tap '${tapId}': [${grips}]`;
};

let result = "EvaluationDelta:\n";

if (delta.added.size > 0) {
result += ` Added (${delta.added.size}):\n`;
delta.added.forEach((attr) => {
result += `${formatAttribution(attr)}\n`;
});
}

if (delta.removed.size > 0) {
result += ` Removed (${delta.removed.size}):\n`;
delta.removed.forEach((attr) => {
result += `${formatAttribution(attr)}\n`;
});
}

if (delta.added.size === 0 && delta.removed.size === 0) {
result += " No changes.";
}

return result;
}

// ---[ Utility Components ]------------------------------------------------------

/**
* Maps input Grips to the queries that depend on them for efficient reactive updates.
* 
* The inverted index enables the evaluator to quickly determine which queries
* need to be re-evaluated when specific Grips change. This is essential for
* efficient reactive evaluation without re-evaluating all queries.
* 
* Key Features:
* - O(1) lookup of affected queries for changed Grips
* - Incremental updates when bindings are added/removed
* - Automatic cleanup of empty Grip entries
*/
export class InvertedIndex {
private index = new Map<Grip<any>, Set<Query>>();

/**
* Adds a query's characteristics to the index.
* 
* For each Grip in the query's conditions, adds the query to the set
* of queries that depend on that Grip.
* 
* @param query - The query to add to the index
*/
public add(query: Query): void {
for (const grip of query.conditions.keys()) {
if (!this.index.has(grip)) {
this.index.set(grip, new Set());
}
this.index.get(grip)!.add(query);
}
}

/**
* Removes a query from the index.
* 
* For each Grip in the query's conditions, removes the query from the set
* of queries that depend on that Grip. Cleans up empty Grip entries.
* 
* @param query - The query to remove from the index
*/
public remove(query: Query): void {
for (const grip of query.conditions.keys()) {
const queries = this.index.get(grip);
if (queries) {
queries.delete(query);
if (queries.size === 0) {
this.index.delete(grip);
}
}
}
}

/**
* Retrieves all queries that are affected by a change in one or more Grips.
* 
* This is the core method for reactive evaluation - it determines which
* queries need to be re-evaluated when specific Grips change.
* 
* @param changedGrips - Set of Grips that have changed value
* @returns Set of unique Queries that need to be re-evaluated
*/
public getAffectedQueries(changedGrips: Set<Grip<any>>): Set<Query> {
const affected = new Set<Query>();
for (const grip of changedGrips) {
const queries = this.index.get(grip);
if (queries) {
for (const query of queries) {
affected.add(query);
}
}
}
return affected;
}
}

// ---[ Main Evaluator Logic ]----------------------------------------------------

/**
* A stateless utility to handle attribution logic.
* 
* The attribution process determines which Taps should be active and which
* output Grips each Tap should provide. It handles conflicts between Taps
* that provide the same Grips by using scores and binding IDs for tie-breaking.
* 
* Key Algorithm:
* 1. Group Taps by their output Grips using disjoint set partitioning
* 2. For each group, sort Taps by score (descending) and binding ID
* 3. Attribute each output Grip to the highest-scoring Tap that provides it
* 4. Handle conflicts by giving each Grip to the first Tap that can provide it
*/
class AttributionUtility {
/**
* Attributes output Grips to Taps based on scores and conflicts.
* 
* @param matches - Array of matched Taps with their scores
* @returns Map of Taps to their attributions (which Grips they should provide)
*/
public attribute(matches: MatchedTap[]): Map<Tap | TapFactory, TapAttribution> {
const attributed = new Map<Tap | TapFactory, TapAttribution>();
const partitioner = new DisjointSetPartitioner<MatchedTap, Grip<any>>();

// Group Taps by their output Grips
for (const match of matches) {
partitioner.add(match, Array.from(match.tap.provides));
}

// Process each group of conflicting Taps
for (const partition of partitioner.getPartitions()) {
// Sort by score (descending) and binding ID for tie-breaking
const sortedTaps = Array.from(partition).sort(
(a, b) => b.score - a.score || a.bindingId.localeCompare(b.bindingId),
);
const seenOutputs = new Set<Grip<any>>();

// Attribute each output Grip to the first Tap that can provide it
for (const matchedTap of sortedTaps) {
const novelOutputs = Array.from(matchedTap.tap.provides).filter((g) => !seenOutputs.has(g));

if (novelOutputs.length > 0) {
const tapAttribution: TapAttribution = {
producerTap: matchedTap.tap,
score: matchedTap.score,
bindingId: matchedTap.bindingId,
attributedGrips: new Set(novelOutputs),
};
attributed.set(matchedTap.tap, tapAttribution);
novelOutputs.forEach((g) => seenOutputs.add(g));
}
}
}
return attributed;
}
}

/**
* The central query evaluator for the GRIP engine with hybrid optimization.
* 
* The QueryEvaluator is the core component that determines which Taps should
* be active based on declarative query conditions. It implements sophisticated
* optimization strategies to handle large numbers of queries efficiently.
* 
* Key Features:
* - Hybrid evaluation strategy (precomputation + runtime)
* - Intelligent caching with complexity-based thresholds
* - Incremental binding management
* - Reactive evaluation on Grip changes
* - Efficient attribution with conflict resolution
* 
* Performance Strategy:
* - Low-complexity query sets: Precompute all possible combinations
* - High-complexity query sets: Evaluate at runtime with caching
* - Automatic threshold-based switching between strategies
* - Incremental updates with minimal re-evaluation
*/
export class QueryEvaluator {
private bindings = new Map<string, QueryBinding>(); // Keyed by binding.id
private invertedIndex = new InvertedIndex();
private activeMatches = new Map<string, MatchedTap>(); // Caches the last match result for each binding
private attributionUtility = new AttributionUtility();
private inputGripRefCounts = new Map<Grip<any>, number>();
private lastAttributedResult = new Map<Tap | TapFactory, TapAttribution>();
private structurallyChangedQueries = new Set<Query>();

// Caching and evaluation strategy state
private useHybridEvaluation: boolean;
private useCache: boolean;
private queryPartitioner = new DisjointSetPartitioner<Query, Grip<any>>();
private precomputationThreshold: number;
private precomputedMaps = new Map<
Set<Query>,
TupleMap<any[], Map<Tap | TapFactory, TapAttribution>>
>();
private runtimeEvaluationSets = new Set<Set<Query>>();
private cache = new TupleMap<any[], Map<Tap | TapFactory, TapAttribution>>();
private queryToPartition = new Map<Query, Set<Query>>();
private partitionToKeyGrips = new Map<Set<Query>, Grip<any>[]>();

/**
* Constructs a QueryEvaluator with optional initial bindings and configuration.
* 
* @param initialBindings - Optional array of initial query bindings
* @param precomputationThreshold - Threshold for switching to precomputation (default: 1000)
* @param useHybridEvaluation - Whether to use hybrid evaluation strategy (default: true)
* @param useCache - Whether to use caching (default: true)
*/
constructor(
initialBindings: QueryBinding[] = [],
precomputationThreshold: number = 1000,
useHybridEvaluation: boolean = true,
useCache: boolean = true,
) {
this.precomputationThreshold = precomputationThreshold;
this.useHybridEvaluation = useHybridEvaluation;
this.useCache = useCache;
initialBindings.forEach((b) => this.addBinding(b));
}

/**
* Retrieves a binding by its ID.
* 
* @param bindingId - The ID of the binding to retrieve
* @returns The binding if found, undefined otherwise
*/
public getBinding(bindingId: string): QueryBinding | undefined {
return this.bindings.get(bindingId);
}

/**
* Incrementally adds a new query binding to the evaluator.
* 
* When a binding is added:
* 1. If it replaces an existing binding, remove the old one first
* 2. Add the binding to the internal maps and inverted index
* 3. Update input Grip reference counts
* 4. Update hybrid evaluation state if enabled
* 5. Clear caches due to structural changes
* 
* @param binding - The QueryBinding to add
* @returns Object containing newly introduced and removed input Grips
*/
public addBinding(binding: QueryBinding): AddBindingResult {
const newInputs = new Set<Grip<any>>();
let removedInputs = new Set<Grip<any>>();

// If replacing an existing binding, remove it first
if (this.bindings.has(binding.id)) {
const removeResult = this.removeBinding(binding.id);
removedInputs = removeResult.removedInputs;
}

// Add the new binding
this.bindings.set(binding.id, binding);
this.invertedIndex.add(binding.query);
this.structurallyChangedQueries.add(binding.query);
this.cache.clear();

// Update input Grip reference counts
for (const grip of binding.query.conditions.keys()) {
const currentCount = this.inputGripRefCounts.get(grip) || 0;
if (currentCount === 0) {
newInputs.add(grip);
}
this.inputGripRefCounts.set(grip, currentCount + 1);
}

// Update hybrid evaluation state
if (this.useHybridEvaluation) {
const changedPartitionRecord = this.queryPartitioner.add(
binding.query,
Array.from(binding.query.conditions.keys()),
);
this.updateHybridStateForPartition(changedPartitionRecord.items);
}
return { newInputs, removedInputs };
}

/**
* Incrementally removes a query binding from the evaluator.
* 
* When a binding is removed:
* 1. Remove the binding from internal maps and inverted index
* 2. Update input Grip reference counts
* 3. Update hybrid evaluation state if enabled
* 4. Clear caches due to structural changes
* 
* @param bindingId - The ID of the binding to remove
* @returns Object containing input Grips that are no longer used
*/
public removeBinding(bindingId: string): RemoveBindingResult {
const removedInputs = new Set<Grip<any>>();
const binding = this.bindings.get(bindingId);
if (binding) {
// Remove the binding
this.bindings.delete(bindingId);
this.invertedIndex.remove(binding.query);
this.activeMatches.delete(bindingId);
this.structurallyChangedQueries.add(binding.query);
this.cache.clear();

// Update input Grip reference counts
for (const grip of binding.query.conditions.keys()) {
const currentCount = this.inputGripRefCounts.get(grip);
if (currentCount) {
if (currentCount === 1) {
this.inputGripRefCounts.delete(grip);
removedInputs.add(grip);
} else {
this.inputGripRefCounts.set(grip, currentCount - 1);
}
}
}

// Update hybrid evaluation state
if (this.useHybridEvaluation) {
const removedFrom = this.queryPartitioner.remove(binding.query);
if (removedFrom) {
this.clearHybridStateForPartition(removedFrom.items);
const newPartitions = this.queryPartitioner.repartitionDirtySets();
newPartitions.forEach((p) => this.updateHybridStateForPartition(p.items));
}
}
}
return { removedInputs };
}

/**
* Returns a complete set of all input Grips used by any query in the evaluator.
* 
* @returns Set of all unique input Grips
*/
public getAllInputGrips(): Set<Grip<any>> {
return new Set(this.inputGripRefCounts.keys());
}

/**
* Updates the hybrid evaluation state for a partition of queries.
* 
* Determines whether to precompute or use runtime evaluation based on
* the complexity of the query partition.
* 
* @param partition - Set of queries to update state for
*/
private updateHybridStateForPartition(partition: Set<Query>): void {
this.clearHybridStateForPartition(partition);

if (this.calculateComplexity(partition) <= this.precomputationThreshold) {
this.precomputePartition(partition);
} else {
this.runtimeEvaluationSets.add(partition);
}
partition.forEach((q) => this.queryToPartition.set(q, partition));
}

/**
* Clears hybrid evaluation state for a partition.
* 
* @param partition - Set of queries to clear state for
*/
private clearHybridStateForPartition(partition: Set<Query>): void {
this.precomputedMaps.delete(partition);
this.runtimeEvaluationSets.delete(partition);
this.partitionToKeyGrips.delete(partition);
partition.forEach((q) => this.queryToPartition.delete(q));
}

/**
* Calculates the complexity of a query partition.
* 
* Complexity is the product of the number of possible values for each
* input Grip. This determines whether to use precomputation or runtime evaluation.
* 
* @param partition - Set of queries to calculate complexity for
* @returns Complexity score (higher = more complex)
*/
private calculateComplexity(partition: Set<Query>): number {
const gripValues = new Map<Grip<any>, Set<any>>();
for (const query of partition) {
for (const [grip, valuesMap] of query.conditions.entries()) {
if (!gripValues.has(grip)) gripValues.set(grip, new Set());
const gripSet = gripValues.get(grip)!;
for (const value of valuesMap.keys()) {
gripSet.add(value);
}
}
}
let complexity = 1;
for (const values of gripValues.values()) {
complexity *= values.size;
if (complexity > this.precomputationThreshold) return complexity; // Early exit
}
return complexity;
}

/**
* Precomputes all possible combinations for a query partition.
* 
* For low-complexity partitions, this method generates all possible
* combinations of input values and precomputes the attribution results.
* This enables O(1) lookup during evaluation.
* 
* @param partition - Set of queries to precompute for
*/
private precomputePartition(partition: Set<Query>): void {
const precomputedMap = new TupleMap<any[], Map<Tap | TapFactory, TapAttribution>>();
const grips = new Set<Grip<any>>();
for (const query of partition) {
query.conditions.forEach((_, grip) => grips.add(grip));
}

const gripArray = Array.from(grips).sort((a, b) => a.key.localeCompare(b.key));
this.partitionToKeyGrips.set(partition, gripArray);

const allGripValues = new Map<Grip<any>, any[]>();
for (const grip of gripArray) {
const values = new Set<any>();
for (const query of partition) {
query.conditions.get(grip)?.forEach((_, value) => values.add(value));
}
allGripValues.set(grip, Array.from(values));
}

// Generate all possible combinations and precompute results
const generateCombinations = (index: number, currentCombination: [Grip<any>, any][]) => {
if (index === gripArray.length) {
const context = { getValue: (g: Grip<any>) => new Map(currentCombination).get(g) };
const key = gripArray.map((g) => context.getValue(g));
const matches = this.evaluateQueries(partition, context);
const attributed = this.attributionUtility.attribute(Array.from(matches.values()));
precomputedMap.set(key, attributed);
return;
}
const grip = gripArray[index];
const values = allGripValues.get(grip) || [undefined];
for (const value of values) {
currentCombination.push([grip, value]);
generateCombinations(index + 1, currentCombination);
currentCombination.pop();
}
};

generateCombinations(0, []);
this.precomputedMaps.set(partition, precomputedMap);
}

/**
* Evaluates a set of queries against a given context.
* 
* This method is responsible for evaluating a set of queries against the
* current Grip values to determine which Taps should be active.
* 
* @param queries - Set of queries to evaluate
* @param context - The current GripContext providing values
* @returns Map of newly calculated matches, keyed by bindingId
*/
private evaluateQueries(queries: Set<Query>, context: any): Map<string, MatchedTap> {
const newMatches = new Map<string, MatchedTap>();

const bindingsToEvaluate: QueryBinding[] = [];
for (const binding of this.bindings.values()) {
if (queries.has(binding.query)) {
bindingsToEvaluate.push(binding);
}
}

for (const binding of bindingsToEvaluate) {
let totalScore = 0;

if (binding.query.conditions.size === 0) {
continue;
}

let allConditionsMatch = true;
for (const [grip, valuesAndScoresMap] of binding.query.conditions.entries()) {
const currentValue = context.getValue(grip);
if (currentValue === undefined || !valuesAndScoresMap.has(currentValue)) {
allConditionsMatch = false;
break;
}
totalScore += valuesAndScoresMap.get(currentValue)!;
}

if (allConditionsMatch) {
newMatches.set(binding.id, {
tap: binding.tap,
score: binding.baseScore + totalScore,
bindingId: binding.id,
});
}
}
return newMatches;
}

/**
* The main entry point for the evaluator, called when Grip values change.
* 
* This method is triggered when the GripContext changes, and it:
* 1. Determines which queries are affected by the Grip changes
* 2. Re-evaluates the queries that are structurally changed or affected
* 3. Updates the activeMatches cache
* 4. Runs attribution on the complete set of all active matches
* 5. Calculates the delta of attributions that have been added or removed
* 6. Returns the delta for incremental updates
* 
* @param changedGrips - Set of Grips that have new values
* @param context - The current GripContext
* @returns The delta of attributions that have been added or removed
*/
public onGripsChanged(changedGrips: Set<Grip<any>>, context: any): EvaluationDelta {
const queriesToReevaluate = this.invertedIndex.getAffectedQueries(changedGrips);

for (const query of this.structurallyChangedQueries) {
queriesToReevaluate.add(query);
}
this.structurallyChangedQueries.clear();

// Update active matches based on the re-evaluated queries
const newMatches = this.evaluateQueries(queriesToReevaluate, context);
for (const query of queriesToReevaluate) {
const associatedBindings = Array.from(this.bindings.values()).filter(
(b) => b.query === query,
);
for (const binding of associatedBindings) {
const newMatch = newMatches.get(binding.id);
const oldMatch = this.activeMatches.get(binding.id);

if (oldMatch && !newMatch) {
this.activeMatches.delete(binding.id);
} else if (newMatch) {
this.activeMatches.set(binding.id, newMatch);
}
}
}

// Now, run attribution on the complete, updated set of all active matches
const allActiveMatches = Array.from(this.activeMatches.values());

let newResult: Map<Tap | TapFactory, TapAttribution>;

if (this.useCache) {
const keyGrips = this.getAllInputGrips();
const key = Array.from(keyGrips)
.sort((a, b) => a.key.localeCompare(b.key))
.map((g) => context.getValue(g));

if (this.cache.has(key)) {
newResult = this.cache.get(key)!;
} else {
newResult = this.attributionUtility.attribute(allActiveMatches);
this.cache.set(key, newResult);
}
} else {
newResult = this.attributionUtility.attribute(allActiveMatches);
}

// Calculate the delta
const added = new Map<Tap | TapFactory, TapAttribution>();
const removed = new Map<Tap | TapFactory, TapAttribution>();
const allTaps = new Set([...newResult.keys(), ...this.lastAttributedResult.keys()]);

for (const tap of allTaps) {
const newAttr = newResult.get(tap);
const oldAttr = this.lastAttributedResult.get(tap);

if (newAttr && !oldAttr) {
added.set(tap, newAttr);
} else if (!newAttr && oldAttr) {
removed.set(tap, oldAttr);
} else if (newAttr && oldAttr) {
const newlyWonGrips = new Set<Grip<any>>();
for (const grip of newAttr.attributedGrips) {
if (!oldAttr.attributedGrips.has(grip)) {
newlyWonGrips.add(grip);
}
}

const lostGrips = new Set<Grip<any>>();
for (const grip of oldAttr.attributedGrips) {
if (!newAttr.attributedGrips.has(grip)) {
lostGrips.add(grip);
}
}

if (newlyWonGrips.size > 0) {
added.set(tap, { ...newAttr, attributedGrips: newlyWonGrips });
}
if (lostGrips.size > 0) {
removed.set(tap, { ...oldAttr, attributedGrips: lostGrips });
}
}
}

this.lastAttributedResult = newResult;
return { added, removed };
}
}
