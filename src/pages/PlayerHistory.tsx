import { useState, useEffect } from "react";
import { getContract, short, fetchJsonFromBulletin, asBytes20 } from "../utils.ts";
import type { PlayerData, Move } from "../types.ts";

const MOVE_EMOJI: Record<Move, string> = { rock: "✊", paper: "✋", scissors: "✂️" };

export default function PlayerHistory({ playerAddress, onBack }: {
    playerAddress: string;
    onBack: () => void;
}) {
    const [data, setData] = useState<PlayerData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setData(null);
        setError(null);
        (async () => {
            try {
                const lb = getContract();
                if (!lb) return;

                const cidRes = await lb.getPlayerCid.query(asBytes20(playerAddress));
                if (!cidRes.success) throw new Error("Unable to read player history");
                if (cancelled) return;
                if (!cidRes.value) {
                    setLoading(false);
                    return;
                }

                const history = await fetchJsonFromBulletin<PlayerData>(cidRes.value);
                if (!cancelled) setData(history);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load player history");
                console.error("Failed to load history:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [playerAddress]);

    if (loading) return <div className="spinner">Loading history...</div>;
    if (error) return <div className="empty" role="alert">{error}</div>;
    if (!data) return <div className="empty">No game history found for this player.</div>;

    const winRate = data.totalGames > 0
        ? Math.round((data.wins / data.totalGames) * 100)
        : 0;

    return (
        <div className="history">
            <button className="back-btn" onClick={onBack} style={{ padding: "0 0 12px 0" }}>
                &larr; Back to leaderboard
            </button>

            <h2>{short(playerAddress)}</h2>

            <div className="stats-row">
                <div className="stat-card">
                    <div className="stat-value">{data.totalGames}</div>
                    <div className="stat-label">Games</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value" style={{ color: "var(--success)" }}>{data.wins}</div>
                    <div className="stat-label">Wins</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value" style={{ color: "var(--danger)" }}>{data.losses}</div>
                    <div className="stat-label">Losses</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value" style={{ color: "var(--warning)" }}>{data.draws}</div>
                    <div className="stat-label">Draws</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{winRate}%</div>
                    <div className="stat-label">Win Rate</div>
                </div>
            </div>

            {data.games.slice().reverse().map(game => (
                <div key={game.id} className="history-card">
                    <div className="history-card-header">
                        <div>
                            <span className="history-card-mode">{game.mode}</span>
                            {game.mode === "multiplayer" && game.opponent !== "computer" && (
                                <span style={{ fontSize: 11, color: "var(--text2)", marginLeft: 8 }}>
                                    vs {short(game.opponent)}
                                </span>
                            )}
                        </div>
                        <div className={`history-card-result ${game.result}`}>
                            {game.result.toUpperCase()} ({game.pointsChange > 0 ? `+${game.pointsChange}` : game.pointsChange})
                        </div>
                    </div>
                    <div className="history-card-rounds">
                        {game.rounds.map((r, i) => (
                            <span key={i} className="round-badge" title={`${r.playerMove} vs ${r.opponentMove}: ${r.result}`}>
                                {MOVE_EMOJI[r.playerMove]} vs {MOVE_EMOJI[r.opponentMove]}
                            </span>
                        ))}
                    </div>
                    <div className="history-card-footer">
                        <span>{new Date(game.timestamp * 1000).toLocaleDateString()}</span>
                        {game.roomCode && <span className="badge">Room: {game.roomCode}</span>}
                    </div>
                </div>
            ))}
        </div>
    );
}
