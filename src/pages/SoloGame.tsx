import { useState } from "react";
import type { AppAccount } from "../utils.ts";
import type { Move, Round, GameData, PlayerData, RoundResult } from "../types.ts";
import {
    determineWinner, pointsForResult, randomMove,
    uploadToBulletin, ensureMapping, getContract, withTimeout,
    readPlayerData, asBytes20,
} from "../utils.ts";

const MOVE_EMOJI: Record<Move, string> = { rock: "✊", paper: "✋", scissors: "✂️" };
const RESULT_TEXT: Record<RoundResult, string> = { win: "You win!", loss: "You lose!", draw: "Draw!" };
const BEST_OF = 3;

export default function SoloGame({ account, onDone }: {
    account: AppAccount;
    onDone: () => void;
}) {
    const [rounds, setRounds] = useState<Round[]>([]);
    const [currentRound, setCurrentRound] = useState<Round | null>(null);
    const [gameOver, setGameOver] = useState(false);
    const [saving, setSaving] = useState(false);
    const [statusMsg, setStatusMsg] = useState("");

    const playerWins = rounds.filter(r => r.result === "win").length;
    const computerWins = rounds.filter(r => r.result === "loss").length;
    const roundNumber = rounds.length + 1;

    const pickMove = (move: Move) => {
        if (currentRound || gameOver) return;
        const opponentMove = randomMove();
        const result = determineWinner(move, opponentMove);
        const round: Round = { playerMove: move, opponentMove, result };
        setCurrentRound(round);

        setTimeout(() => {
            const newRounds = [...rounds, round];
            setRounds(newRounds);
            setCurrentRound(null);
            const w = newRounds.filter(r => r.result === "win").length;
            const l = newRounds.filter(r => r.result === "loss").length;
            const needed = Math.ceil(BEST_OF / 2);
            if (w >= needed || l >= needed || newRounds.length >= BEST_OF) {
                setGameOver(true);
            }
        }, 1500);
    };

    const overallResult: RoundResult = playerWins > computerWins ? "win" : computerWins > playerWins ? "loss" : "draw";
    const pts = pointsForResult(overallResult);

    const saveToChain = async () => {
        setSaving(true);
        try {
            const lb = getContract();
            if (!lb) {
                setStatusMsg("Contract not deployed — run `cdm deploy && cdm install`");
                setSaving(false);
                return;
            }

            setStatusMsg("Fetching existing history...");
            let playerData: PlayerData = {
                player: account.h160Address,
                totalGames: 0, wins: 0, losses: 0, draws: 0, points: 0,
                games: [],
            };

            const existing = await readPlayerData(() => lb.getPlayerCid.query(asBytes20(account)));
            if (existing) playerData = existing;

            const game: GameData = {
                id: playerData.games.length + 1,
                mode: "solo",
                opponent: "computer",
                rounds,
                result: overallResult,
                pointsChange: pts,
                timestamp: Math.floor(Date.now() / 1000),
            };

            playerData.games.push(game);
            playerData.totalGames++;
            if (overallResult === "win") playerData.wins++;
            else if (overallResult === "loss") playerData.losses++;
            else playerData.draws++;
            playerData.points += pts;

            setStatusMsg("Uploading to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(playerData));
            const newCid = await uploadToBulletin(account, bytes);

            setStatusMsg("Ensuring account mapping...");
            await ensureMapping(account);

            const regRes = await lb.isRegistered.query(asBytes20(account));
            if (regRes.success && !regRes.value) {
                setStatusMsg("Registering player...");
                await withTimeout(lb.register.tx(), 120_000, "register.tx");
            }

            setStatusMsg("Updating leaderboard...");
            await withTimeout(
                lb.updateResult.tx(newCid, BigInt(pts)),
                120_000, "updateResult.tx",
            );

            setStatusMsg("Saved!");
        } catch (err) {
            console.error("Save error:", err);
            setStatusMsg("Failed to save - check console");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="game-page">
            <h2>Solo - Best of {BEST_OF}</h2>

            <div className="score-display">
                <div>You: <span>{playerWins}</span></div>
                <div>Round <span>{Math.min(roundNumber, BEST_OF)}</span>/{BEST_OF}</div>
                <div>CPU: <span>{computerWins}</span></div>
            </div>

            {currentRound && (
                <div className="round-result">
                    <div className="round-result-moves">
                        <span>{MOVE_EMOJI[currentRound.playerMove]}</span>
                        <span className="round-result-vs">VS</span>
                        <span>{MOVE_EMOJI[currentRound.opponentMove]}</span>
                    </div>
                    <div className={`round-result-text ${currentRound.result}`}>
                        {RESULT_TEXT[currentRound.result]}
                    </div>
                </div>
            )}

            {!gameOver && !currentRound && (
                <div className="move-picker">
                    {(["rock", "paper", "scissors"] as Move[]).map(m => (
                        <div key={m}>
                            <button className="move-btn" onClick={() => pickMove(m)}>
                                {MOVE_EMOJI[m]}
                            </button>
                            <div className="move-label">{m}</div>
                        </div>
                    ))}
                </div>
            )}

            {gameOver && (
                <div className="round-result">
                    <div className={`round-result-text ${overallResult}`} style={{ fontSize: 24, marginBottom: 8 }}>
                        {overallResult === "win" ? "You won the match!" :
                         overallResult === "loss" ? "You lost the match!" : "Match drawn!"}
                    </div>
                    <div style={{ fontSize: 14, color: "var(--text2)", marginBottom: 16 }}>
                        {playerWins} - {computerWins} ({pts > 0 ? `+${pts}` : pts} pts)
                    </div>

                    <div className="history-card-rounds" style={{ justifyContent: "center", marginBottom: 16 }}>
                        {rounds.map((r, i) => (
                            <span key={i} className="round-badge">
                                {MOVE_EMOJI[r.playerMove]} vs {MOVE_EMOJI[r.opponentMove]}
                            </span>
                        ))}
                    </div>

                    {statusMsg && <div className="status">{statusMsg}</div>}

                    <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                        <button className="btn btn-primary" onClick={saveToChain} disabled={saving}>
                            {saving ? "Saving..." : "Save to Chain"}
                        </button>
                        <button className="btn btn-ghost" onClick={onDone}>
                            Home
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
