// Import TypeScript modules
import { LANCER } from "../config";
import { LancerActor, LancerMECH, LancerNPC } from "../actor/lancer-actor";
import { AccDiffData, AccDiffDataSerialized } from "../helpers/acc_diff";
import { encodeMacroData } from "./encode";
import { resolveItemOrActor } from "./util";
import { renderTemplateStep } from "./_render";
import { attackRolls } from "./attack";
import { SystemTemplates } from "../system-template";
import { LancerFlowState } from "./interfaces";
import { openSlidingHud } from "../helpers/slidinghud";
import { LancerItem } from "../item/lancer-item";
import { ActionData } from "../models/bits/action";
import { resolve_dotpath } from "../helpers/commons";
import { ActivationType, AttackType } from "../enums";
import { Tag } from "../models/bits/tag";

const lp = LANCER.log_prefix;

export async function prepareTechMacro(
  docUUID: string | LancerActor | LancerItem,
  options?: {
    action_path?: string;
  }
) {
  // Determine provided doc
  let { item, actor } = resolveItemOrActor(docUUID);
  if (!actor) return;

  let mData: Partial<LancerFlowState.AttackRollData>;
  let acc_diff: AccDiffData;
  if (actor && !item) {
    // If we weren't passed an item assume generic "basic tech attack" roll
    // TODO: make an actual flow to this that lets people pick an action/invade/item

    if (!(actor.is_mech() || actor.is_npc())) {
      ui.notifications!.error(`Error rolling tech attack macro (not a valid tech attacker).`);
      return;
    }
    let acc = actor.is_mech() && actor.system.loadout.frame?.value?.system.lid == "mf_goblin" ? 1 : 0;
    acc_diff = AccDiffData.fromParams(actor, [], "BASIC TECH", Array.from(game.user!.targets), acc);
    mData = {
      // docUUID: actor.uuid,
      title: "BASIC TECH",
      flat_bonus: actor.system.tech_attack,
      tags: [],
      attack_type: AttackType.Tech,
    };
  } else if (item) {
    // Get the item
    if (item.is_npc_feature()) {
      // NPC features don't really have explicit actions
      let tier_index: number = (item.system.tier_override || (item.actor as LancerNPC).system.tier) - 1;

      if (item.system.tags.some(t => t.is_recharge) && !item.system.charged) {
        ui.notifications!.warn(`Feature ${item.name} is not charged!`);
        return;
      }

      let sys = item.system as SystemTemplates.NPC.TechData;
      let acc = sys.accuracy[tier_index] ?? 0;
      acc_diff = AccDiffData.fromParams(item, item.getTags() ?? [], item.name!, Array.from(game.user!.targets), acc);
      mData = {
        // docUUID: item.uuid,
        title: item.name!,
        attack_type: AttackType.Tech, //sys.tech_type,
        flat_bonus: sys.attack_bonus[tier_index] ?? 0,
        tags: sys.tags ?? undefined,
        effect: sys.effect,
      };
    } else {
      // Get the action if possible
      let action: ActionData | null = null;
      if (options?.action_path) {
        action = resolve_dotpath(item, options.action_path);
      }
      if (action) {
        // Use the action data
        mData = {
          // docUUID: item.uuid,
          title: action.name == ActivationType.Invade ? `INVADE // ${action.name}` : action.name,
          attack_type: AttackType.Tech,
          effect: action.detail,
          flat_bonus: (item.actor as LancerMECH).system.tech_attack,
          tags: item.getTags() ?? undefined,
        };
      } else if (item.is_mech_system()) {
        // Use the system effect as a fallback
        mData = {
          // docUUID: item.uuid,
          title: item.name!,
          attack_type: AttackType.Tech,
          effect: item.system.effect,
          flat_bonus: (item.actor as LancerMECH).system.tech_attack,
          tags: item.getTags() ?? undefined,
        };
      } else {
        ui.notifications!.error(
          `Error rolling tech attack macro - not the appropriate way of invoking this type of item, probably`
        );
        return;
      }
      acc_diff = AccDiffData.fromParams(item, item.getTags() ?? [], mData.title, Array.from(game.user!.targets));
    }
    console.log(`${lp} Tech Attack Macro Item:`, item, mData);
  } else {
    return;
  }

  // Summon prompt
  acc_diff = await openSlidingHud("attack", acc_diff);
  // mData.acc_diff = acc_diff.toObject();

  // Un-charge
  if (item && item.is_npc_feature() && item.system.tags.some(t => t.is_recharge)) {
    await item.update({ "system.charged": false });
  }

  await rollTechMacro(mData as LancerFlowState.AttackRollData);
}

export async function rollTechMacro(data: LancerFlowState.AttackRollData, reroll: boolean = false) {
  // Get actor
  // let { actor } = resolveItemOrActor(data.docUUID);
  let actor = undefined;
  if (!actor) return;

  // Populate and possibly regenerate ADD if reroll
  // let add = AccDiffData.fromObject(data.acc_diff);
  let add = data.acc_diff!;
  if (reroll) {
    // Re-prompt
    add.replaceTargets(Array.from(game!.user!.targets));
    add = await openSlidingHud("attack", add);
    // data.acc_diff = add.toObject();
  }

  let rerollInvocation: LancerFlowState.InvocationData = {
    title: "RollMacro",
    fn: "rollTechMacro",
    args: [data, true],
  };

  let atkRolls = attackRolls(data.flat_bonus, add);
  if (!atkRolls) return;

  // TODO: use rollAttacks from ./attacks
  // const { attacks, hits } = await checkTargets(atkRolls, true); // true = all tech attacks are "smart"
  const attacks: any = [];
  const hits: any = [];

  // Output
  const templateData = {
    title: data.title,
    attacks: attacks,
    hits: hits,
    effect: data.effect ? data.effect : null,
    tags: data.tags?.map(t => new Tag(t)) ?? [],
    rerollMacroData: encodeMacroData(rerollInvocation),
  };

  const template = `systems/${game.system.id}/templates/chat/tech-attack-card.hbs`;
  return await renderTemplateStep(actor, template, templateData);
}