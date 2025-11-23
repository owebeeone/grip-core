/**
 * GRIP Query System - Declarative conditions for Tap selection
 *
 * Provides a declarative way to specify conditions that determine which Taps
 * should be active based on Grip values. The query system enables dynamic
 * Tap selection through declarative conditions rather than imperative logic.
 *
 * Key Features:
 * - Declarative condition specification
 * - Equality and inclusion conditions
 * - Score-based Tap prioritization
 * - Fluent builder API
 * - Performance-optimized evaluation
 *
 * Architecture:
 * - Query: Immutable condition specification
 * - QueryBuilder: Fluent API for building queries
 * - QueryConditions: Map of Grip conditions with match scores
 * - QueryMatchScoreMap: Map of value-to-score mappings
 *
 * Performance Notes:
 * - Optimized for large numbers of query expressions
 * - Constant-time evaluation complexity
 * - Limited to equality and inclusion for performance
 * - Complex conditions should use FunctionTaps instead
 */

import type { Grip } from "./grip";
import type { Tap } from "./tap";

/**
 * Map of match values to their corresponding scores.
 *
 * Used to specify which values match a condition and what score
 * they should contribute to the Tap's overall evaluation score.
 */
export type QueryMatchScoreMap = ReadonlyMap<any, number>; // match value -> score

/**
 * Map of Grips to their condition specifications.
 *
 * Each Grip can have one condition that specifies which values
 * match and what scores they contribute.
 */
export type QueryConditions = ReadonlyMap<Grip<any>, QueryMatchScoreMap>;

// Mutable versions for internal use
type MutableQueryMatchScoreMap = Map<any, number>;
type MutableQueryConditions = Map<Grip<any>, MutableQueryMatchScoreMap>;

/**
 * Immutable query specification containing conditions for Tap selection.
 *
 * A Query defines a set of conditions that must be satisfied for a Tap
 * to be considered active. Each condition is specified as a Grip and
 * a set of acceptable values with their corresponding scores.
 *
 * The query evaluator uses these conditions to determine which Taps
 * should provide data based on the current values of the specified Grips.
 */
export class Query {
  /** Conditions keyed by Grip identity (only one condition per Grip) */
  public readonly conditions: QueryConditions;

  constructor(conditions: QueryConditions) {
    this.conditions = conditions;
  }
}

/**
 * Fluent builder for creating Query objects.
 *
 * Provides a convenient API for building queries with conditions.
 * Only supports equality and inclusion conditions for performance reasons.
 *
 * Limitations:
 * - Equality conditions: grip.value === targetValue
 * - Inclusion conditions: grip.value is one of targetValues
 * - No complex logical operators (AND, OR, NOT)
 * - No range conditions or custom predicates
 *
 * For complex conditions, use FunctionTaps that compute condition values
 * and then query against those computed values.
 */
export interface QueryBuilder {
  /**
   * Adds an equality condition for a single value.
   *
   * @param grip - The Grip to match against
   * @param value - The exact value that should match
   * @param score - Optional score for this match (default: 100)
   * @returns The builder for chaining
   */
  oneOf<T>(grip: Grip<T>, value: T, score?: number): QueryBuilder;

  /**
   * Adds an inclusion condition for multiple values.
   *
   * @param grip - The Grip to match against
   * @param values - Array of values that should match (OR condition)
   * @param score - Optional score for these matches (default: 100)
   * @returns The builder for chaining
   */
  anyOf<T>(grip: Grip<T>, values: readonly T[], score?: number): QueryBuilder;

  /**
   * Finalizes the query and returns the immutable Query object.
   *
   * @returns The built Query object
   */
  build(): Query;
}

/**
 * Implementation of QueryBuilder with copy-on-write semantics.
 *
 * Supports building queries with multiple conditions and provides
 * efficient immutable query creation.
 */
class QueryBuilderImpl implements QueryBuilder {
  private conditions = new Map<Grip<any>, MutableQueryMatchScoreMap>() as MutableQueryConditions;
  private isBuilt = false;

  /**
   * Creates a copy of the conditions if the query has been built.
   *
   * Ensures that modifications to the builder don't affect
   * previously built Query objects.
   */
  private copyOnWrite(): void {
    if (this.isBuilt) {
      const newConditions = new Map<Grip<any>, Map<any, number>>();
      for (const [grip, valuesMap] of this.conditions.entries()) {
        newConditions.set(grip, new Map(valuesMap));
      }
      this.conditions = newConditions;
      this.isBuilt = false;
    }
  }

  /**
   * Adds an equality condition for a single value.
   *
   * @param grip - The Grip to match against
   * @param value - The exact value that should match
   * @param score - Optional score for this match (default: 100)
   * @returns The builder for chaining
   */
  oneOf<T>(grip: Grip<T>, value: T, score?: number): this {
    this.copyOnWrite();
    if (!this.conditions.has(grip)) {
      const newMatchScoreMap = new Map<any, number>() as MutableQueryMatchScoreMap;
      this.conditions.set(grip, newMatchScoreMap);
    }
    const valuesAndScoresMap = this.conditions.get(grip)!;
    valuesAndScoresMap.set(value, score ?? 100);
    return this;
  }

  /**
   * Adds an inclusion condition for multiple values.
   *
   * @param grip - The Grip to match against
   * @param values - Array of values that should match (OR condition)
   * @param score - Optional score for these matches (default: 100)
   * @returns The builder for chaining
   */
  anyOf<T>(grip: Grip<T>, values: readonly T[], score?: number): this {
    this.copyOnWrite();
    if (!this.conditions.has(grip)) {
      const newMatchScoreMap = new Map<any, number>() as MutableQueryMatchScoreMap;
      this.conditions.set(grip, newMatchScoreMap);
    }
    const valuesAndScoresMap = this.conditions.get(grip)!;
    const scoreToUse = score ?? 100;

    for (const v of values) {
      valuesAndScoresMap.set(v, scoreToUse);
    }

    return this;
  }

  /**
   * Finalizes the query and returns the immutable Query object.
   *
   * @returns The built Query object
   */
  build(): Query {
    this.isBuilt = true;
    return new Query(this.conditions);
  }
}

/**
 * Factory for creating new QueryBuilder instances.
 *
 * Provides a clean entry point for starting query construction.
 */
export class QueryBuilderFactory {
  /**
   * Creates a new QueryBuilder instance.
   *
   * @returns A fresh QueryBuilder for building queries
   */
  newQuery(): QueryBuilder {
    return new QueryBuilderImpl();
  }
}

/**
 * Helper function to create a query with a single equality condition.
 *
 * Convenience function for simple queries that only need one condition.
 *
 * @param grip - The Grip to match against
 * @param value - The exact value that should match
 * @param score - Optional score for this match (default: 100)
 * @returns A QueryBuilder with the condition already added
 */
export const withOneOf = <T>(grip: Grip<T>, value: T, score?: number): QueryBuilder => {
  return new QueryBuilderFactory().newQuery().oneOf(grip, value, score);
};

/**
 * Helper function to create a query with a single inclusion condition.
 *
 * Convenience function for simple queries that match multiple values.
 *
 * @param grip - The Grip to match against
 * @param values - Array of values that should match (OR condition)
 * @param score - Optional score for these matches (default: 100)
 * @returns A QueryBuilder with the condition already added
 */
export const withAnyOf = <T>(grip: Grip<T>, values: readonly T[], score?: number): QueryBuilder => {
  return new QueryBuilderFactory().newQuery().anyOf(grip, values, score);
};
