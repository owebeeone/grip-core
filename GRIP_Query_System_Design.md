# **V9 GRIP Query System Design**

## **1\. Overview**

This document specifies the complete design for the GRIP Query System, a declarative and reactive mechanism for selecting data producers (Taps) based on the state of a GripContext. It replaces earlier designs that relied on imperative, tap-side Matcher functions with a centralized, declarative QueryEvaluator.

The system is designed to be highly performant and scalable, featuring an incremental, stateful architecture that returns only the delta of changes, alongside powerful optimizations like result caching and a one-step hybrid evaluation strategy.

## **2\. Core Concepts**

The system is built on three fundamental concepts:

1. **Declarative Queries**: Instead of Taps deciding if they match a context, the system is configured with declarative rules called **Querys**. A Query defines a set of conditions based on Grip values.  
2. **Centralized Evaluation**: A single, stateful **QueryEvaluator** holds all Query-to-Tap mappings (QueryBindings). It is the sole authority for evaluating the current context against these queries.  
3. **Incremental Updates & Attribution**: When input Grip values change, the evaluator efficiently determines which queries are affected, re-evaluates them, and calculates the precise set of changes (**delta**) to the winning Taps. Conflict resolution (attribution) is handled as part of this process.

## **3\. Query Definition**

Queries are created programmatically using a fluent, type-safe QueryBuilder. This approach avoids string-based DSLs and ensures correctness at compile time.

### **3.1. Query Structure**

A Query object's conditions are represented by a nested map:  
ReadonlyMap\<Grip\<any\>, ReadonlyMap\<any, number\>\>

* **Outer Map Key**: The input Grip whose value will be checked in the context.  
* **Inner Map Key**: A potential value for the Grip.  
* **Inner Map Value**: The score awarded if the context's value for the Grip matches this key.

This structure creates a logical **AND** between the outer Grip keys (all must be satisfied) and a logical **OR** between the inner value keys (any one can match).

### **3.2. QueryBuilder API**

The QueryBuilder provides a fluent API for constructing Query objects.

* oneOf\<T\>(grip: Grip\<T\>, value: T, score?: number): Adds a single value condition for a Grip.  
* anyOf\<T\>(grip: Grip\<T\>, values: readonly T\[\], score?: number): A convenience method that adds multiple value conditions for a Grip, all with the same score.

**Example:**

import { QueryBuilderFactory } from './query';

const qb \= new QueryBuilderFactory().newQuery();

const MODE \= new Grip\<string\>({ name: 'mode' });  
const REGION \= new Grip\<string\>({ name: 'region' });

// This query matches if MODE is 'live' AND REGION is 'us' or 'eu'.  
const myQuery \= qb()  
  .oneOf(MODE, 'live', 10\)  
  .anyOf(REGION, \['us', 'eu'\], 5\)  
  .build();

## **4\. The Query Evaluator**

The QueryEvaluator is the central class that manages and executes the entire query and attribution process. It is designed to be stateful and incremental.

### **4.1. Core Interfaces**

// Associates a Query with a Tap and a unique ID  
export interface QueryBinding {  
  id: string;  
  query: Query;  
  tap: Tap | TapFactory;  
  baseScore: number;  
}

// The result of an evaluation, representing the changes  
export interface EvaluationDelta {  
    added: Map\<Tap | TapFactory, TapAttribution\>;  
    removed: Map\<Tap | TapFactory, TapAttribution\>;  
}

// The final attribution for a winning Tap  
export interface TapAttribution {  
  producerTap: Tap | TapFactory;  
  score: number;  
  bindingId: string;  
  attributedGrips: Set\<Grip\<any\>\>;  
}

### **4.2. QueryEvaluator Public API**

* constructor(initialBindings?, precomputationThreshold?, useHybridEvaluation?, useCache?): Initializes the evaluator.  
* addBinding(binding: QueryBinding): AddBindingResult: Incrementally adds a new query-to-tap mapping. Returns the set of any newly required input Grips.  
* removeBinding(bindingId: string): RemoveBindingResult: Incrementally removes a binding. Returns the set of any input Grips that are no longer needed by any query.  
* onGripsChanged(changedGrips: Set\<Grip\<any\>\>, context: any): EvaluationDelta: The main evaluation entry point. It takes the set of input Grips that have changed and the current context, and returns a delta of the changes to the attributed taps.  
* getAllInputGrips(): Set\<Grip\<any\>\>: Returns the complete set of unique input Grips required by all currently registered queries.

### **4.3. Internal Logic**

1. **State Management**: The evaluator maintains an internal map of all activeMatches—the QueryBindings that successfully matched the last known context state.  
2. **Reactive Updates**: When onGripsChanged is called, it uses an InvertedIndex to find the precise subset of Query objects affected by the changedGrips.  
3. **Evaluation**: It re-evaluates only this subset of queries against the new context.  
4. **State Update**: It updates its internal activeMatches map by adding new matches, removing those that no longer match, and updating those whose scores may have changed.  
5. **Attribution**: It runs the attribution logic on the *complete, updated set* of activeMatches.  
6. **Delta Calculation**: It compares the new attribution result with its previously stored result to calculate and return the EvaluationDelta.

## **5\. Output Attribution Engine**

The OutputAttributionEngine is a stateful component responsible for resolving conflicts when multiple Taps match and provide overlapping output Grips.

### **5.1. Pre-Partitioning Optimization**

To ensure high performance, the engine does not re-partition matches on every call. Instead, it maintains a persistent DisjointSetPartitioner for **all known Taps**. Taps are partitioned into disjoint sets based on their declared output Grips. This partitioning is updated incrementally whenever a Tap is added or removed via a QueryBinding.

### **5.2. Attribution Algorithm**

When the attribute method is called with the full set of activeMatches:

1. **Group by Partition**: It first groups the active matches based on the pre-calculated partition their Tap belongs to.  
2. **Process Each Group**: For each group of matches, it performs the attribution logic independently:  
   * It sorts the matches in the group by score (descending), using bindingId as a deterministic tie-breaker.  
   * It iterates through the sorted list, assigning output Grips to the highest-scoring Tap that provides them. A Tap only wins attribution for Grips that haven't already been won by a higher-scoring Tap in the same partition.  
3. **Return Result**: The final result is a map from each winning Tap to its TapAttribution record, which contains the exact set of Grips it won.

## **6\. Optimization Strategies**

The evaluator includes two powerful, flag-controlled optimization strategies.

### **6.1. Result Caching (useCache flag)**

When enabled, the evaluator caches the final, attributed result of an evaluation.

* **Key Generation**: A stable key is generated from the values of all getAllInputGrips() in the current context.  
* **Lookup**: On a subsequent call to onGripsChanged with the same context values, the cached result is returned instantly, bypassing the evaluation and attribution steps entirely.  
* **Invalidation**: The cache is automatically cleared whenever a QueryBinding is added or removed.

### **6.2. Hybrid Evaluation (useHybridEvaluation flag)**

This strategy provides a one-step, O(1) lookup for simple query sets by pre-calculating the final attributed results for every possible input combination.

1. **Partitioning**: At startup and on any binding change, all Querys are partitioned by their required input Grips.  
2. **Complexity Analysis**: For each partition, the evaluator calculates the "solution space" (the number of possible input value combinations).  
3. **Pre-computation**: If the complexity is below the precomputationThreshold, the evaluator iterates through every possible combination of input values. For each combination, it runs the full evaluation and attribution logic and stores the final Map\<Tap, TapAttribution\> in a precomputedMap keyed by the input values.  
4. **Runtime**: If a changed Grip belongs to a pre-computed partition, onGripsChanged performs a single lookup in the precomputedMap to get the final result instantly. Partitions that are too complex fall back to the standard runtime evaluation (which can still be cached if useCache is true).

