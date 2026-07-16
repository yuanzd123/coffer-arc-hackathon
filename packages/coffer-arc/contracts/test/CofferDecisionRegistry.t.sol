// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CofferDecisionRegistry} from "../src/CofferDecisionRegistry.sol";

contract UnauthorizedCaller {
    function anchor(CofferDecisionRegistry registry, bytes32 commitment) external {
        registry.anchorDecision(commitment, CofferDecisionRegistry.DecisionOutcome.Approved);
    }
}

contract CofferDecisionRegistryTest {
    function testStoresApprovedCommitmentAndAllowsExactReplay() public {
        CofferDecisionRegistry registry = new CofferDecisionRegistry(address(this));
        bytes32 commitment = keccak256("coffer-allow");

        registry.anchorDecision(commitment, CofferDecisionRegistry.DecisionOutcome.Approved);
        registry.anchorDecision(commitment, CofferDecisionRegistry.DecisionOutcome.Approved);

        CofferDecisionRegistry.AnchoredDecision memory stored = registry.getDecision(commitment);
        require(stored.exists, "decision missing");
        require(stored.outcome == CofferDecisionRegistry.DecisionOutcome.Approved, "wrong outcome");
        require(stored.anchoredAtBlock > 0, "block number missing");
    }

    function testRejectsUnauthorizedCaller() public {
        CofferDecisionRegistry registry = new CofferDecisionRegistry(address(this));
        UnauthorizedCaller caller = new UnauthorizedCaller();
        (bool ok,) = address(caller).call(
            abi.encodeCall(UnauthorizedCaller.anchor, (registry, keccak256("unauthorized")))
        );
        require(!ok, "unauthorized anchor succeeded");
    }

    function testRejectsConflictingReplay() public {
        CofferDecisionRegistry registry = new CofferDecisionRegistry(address(this));
        bytes32 commitment = keccak256("conflict");
        registry.anchorDecision(commitment, CofferDecisionRegistry.DecisionOutcome.Approved);
        (bool ok,) = address(registry).call(
            abi.encodeCall(
                CofferDecisionRegistry.anchorDecision,
                (commitment, CofferDecisionRegistry.DecisionOutcome.Blocked)
            )
        );
        require(!ok, "conflicting decision succeeded");
    }

    function testRejectsZeroCommitment() public {
        CofferDecisionRegistry registry = new CofferDecisionRegistry(address(this));
        (bool ok,) = address(registry).call(
            abi.encodeCall(
                CofferDecisionRegistry.anchorDecision,
                (bytes32(0), CofferDecisionRegistry.DecisionOutcome.Approved)
            )
        );
        require(!ok, "zero commitment succeeded");
    }
}
