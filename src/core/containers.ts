/**
* GRIP Context Containers - Context wrapper utilities
* 
* Provides container classes that wrap and manage multiple GripContexts,
* enabling complex scenarios where different contexts are needed for
* different purposes (e.g., home vs presentation contexts).
* 
* Key Features:
* - Dual context management (home and presentation)
* - Unified interface for multiple contexts
* - GROK engine coordination
* - Context hierarchy management
* 
* Use Cases:
* - Tap matching with separate input and output contexts
* - Complex context hierarchies
* - Context delegation and composition
* - Multi-context Tap management
*/

import { GripContext, GripContextLike } from "./context";
import { Grok } from "./grok";

/**
* Dual-context container that manages home and presentation contexts.
* 
* The DualContextContainer provides a unified interface for managing
* two separate contexts: a home context for inputs/parameters and a
* presentation context for outputs. This is particularly useful for
* Tap matching scenarios where the input and output contexts differ.
* 
* Key Concepts:
* - Home Context: Where inputs and parameters are read from
* - Presentation Context: Where outputs are presented to consumers
* - Unified GROK Engine: Both contexts share the same GROK instance
* - GripContextLike Interface: Provides consistent API for consumers
* 
* This container is commonly used with TapMatcher to separate the
* context where queries are evaluated (home) from the context where
* selected Taps are activated (presentation).
*/
export class DualContextContainer implements GripContextLike {
readonly kind: "DualContextContainer" = "DualContextContainer";
readonly grok: Grok;
readonly home: GripContext;
readonly presentation: GripContext;

/**
* Creates a new DualContextContainer with home and presentation contexts.
* 
* @param home - The home context for inputs and parameters
* @param presentation - The presentation context for outputs
*/
constructor(home: GripContext, presentation: GripContext) {
this.home = home;
this.presentation = presentation;
this.grok = home.getGrok();
}

/**
* Gets the consumer context (presentation context).
* 
* This is the context where outputs are presented to consumers.
* 
* @returns The presentation context
*/
getGripConsumerContext(): GripContext {
return this.presentation;
}

/**
* Gets the home context for inputs and parameters.
* 
* This is the context where inputs are read from and parameters
* are resolved.
* 
* @returns The home context
*/
getGripHomeContext(): GripContext {
return this.home;
}

/**
* Gets the GROK engine shared by both contexts.
* 
* @returns The GROK engine instance
*/
getGrok(): Grok {
return this.grok;
}
}
